# 子專案 5a 第二階段:畫面、人的介入、批准由前景授權 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同伴問答在畫面上看得懂、人隨時接得走:同伴的提問自成一輪、提問方看得到已經等了多久、任何對話發出的批准都出現在人正在看的畫面上,而且人可以代替同伴回答或直接取消一則提問。

**Architecture:** 三塊各自獨立。批准那塊拿掉主行程的「背景就扣住」,一律送進批准登錄表,renderer 把不屬於目前對話的卡片排在後面並標明來源。畫面那塊靠一條規則:注入的提問文字由 `src/shared/peer-tools.ts` 產生也由它解析,`events.ts` 認出來就變成 `peer-question` 事件,`fold.ts` 讓它自成一輪,live 與歷史走同一條路。人的介入那塊由 `PeerService` 對外提供未決問題快照與兩個動作,經一條新的 IPC 頻道推給 renderer。

**Tech Stack:** Electron 44、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、React 19、vitest 4 加 @testing-library/react、zod 4.5.4(只在 main)。

**Spec:** `docs/specs/2026-09-09-yeschef-peer-design.md`(§6.2 畫面、§6.5 人的介入)與 `docs/specs/2026-09-09-yeschef-d2-multi-conversation-design.md` §11(批准由前景授權)。第一階段的機制與兩個工具已經在 main 上,見 `docs/RESULTS-14-5a-acceptance.md`。

## Global Constraints

- 批准逾時 30 秒改 5 分鐘,前景背景同一個值(D2 規格 §11)。這個值只在 `src/main/approval.ts` 出現一次。
- 批准不再扣住:`requestApproval` 不看自己是不是前景,一律進批准登錄表。`held`、`releaseHeld`、`denyHeld`、`HeldAsk` 整套拿掉。
- 不屬於目前對話的批准卡排在自己的卡片之後,標明專案名與對話標籤,點標示就切過去(D2 規格 §11)。
- 注入的提問文字只有一份定義:`src/shared/peer-tools.ts` 的 `formatPeerInjection` 產生、`parsePeerInjection` 解析。`src/main/peer/errors.ts` 的 `PEER_MSG.injection` 改成呼叫前者,不自己拼字串。這是第一階段「文字集中在 peer/errors.ts」那條限制的例外:main 與 renderer 都要用到它,所以放 shared,但仍然只有一份。
- 同伴提問自成一輪,角色標「同伴提問」,不是「你」。做法照壓縮摘要那次:新的 Block 種類 + `Turn.tsx` 換標籤(P 規格 §6.2)。
- 人代替回答寫的 answer,`from` 沿用原問題的 `to`(provider 因此正確),`actor` 是 `'user'`;人取消寫的 cancel 原因是「使用者取消」,`actor` 是 `'user'`,`from` 是原問題的 `to`(P 規格 §6.5 的表)。
- 資料不就地修改:純函式一律回新物件;模組私有的 Map 與 Set 沿用既有做法。
- 使用者與模型可見的文字集中:main 的在 `src/main/peer/errors.ts` 與 `src/main/view-tools/errors.ts`,renderer 的跟著各元件既有做法走。
- 所有測試檔放 `tests/`;檔案系統與時鐘一律注入,測試不碰真的磁碟、不起真的計時器。renderer 測試用 @testing-library/react,沿用既有測試檔的寫法。
- 覆蓋率門檻沿專案:Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令執行,不用 `&&` 串接,不用 `git add -A`/`.`;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 執行 `npm run typecheck` 與 `npx vitest run --exclude tests/measure-memory.test.ts` 都要綠才算完成一個 Task;Task 7 之後跑 `npm run test:coverage` 確認門檻。`tests/measure-memory.test.ts` 會呼叫 `ps`,沙箱擋掉,一律排除。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/renderer/components/PeerQuestion.tsx` | 同伴提問那一輪的內容:誰問的、問什麼、目前狀態、兩顆介入按鈕 |
| `src/renderer/components/PeerQuestion.css` | 同上的樣式 |
| `src/renderer/hooks/usePeer.ts` | 訂閱 `peer:state`,提供未決問題快照與兩個動作 |
| `src/renderer/elapsed.ts` | `useElapsedSeconds(startedAt)`:每秒重算一次,元件卸載時停 |
| `tests/peer-injection-text.test.ts`、`tests/peer-question-fold.test.ts`、`tests/peer-question.test.tsx`、`tests/use-peer.test.tsx`、`tests/elapsed.test.tsx` | 各自的單元測試 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/main/approval.ts` | 預設逾時 30 秒改 5 分鐘 |
| `src/main/conversation.ts` | 拿掉扣住那一整套;`heldApprovals()` 改名 `pendingApprovals()`,值來自批准登錄表 |
| `src/main/ipc-bridge.ts` | 待批准記號改用 `pendingApprovals()`;登錄 peer 的變更通知;兩個新 IPC 的處理 |
| `src/main/peer/service.ts` | 對外提供未決問題快照、變更通知,以及人代替回答與人取消兩個動作 |
| `src/main/peer/errors.ts` | `PEER_MSG.injection` 改成呼叫 shared 的 `formatPeerInjection`;加「使用者取消」那一句 |
| `src/main/index.ts` | 把 peer service 的變更通知接進 bridge |
| `src/shared/peer-tools.ts` | 注入文字的產生與解析 |
| `src/shared/events.ts` | 認出注入的提問,產出 `peer-question` 事件 |
| `src/shared/fold.ts` | `peer-question` 自成一輪,新的 Block 種類 |
| `src/shared/ipc.ts` | 三個新頻道與 payload 型別、`YesChefApi` 三個新成員 |
| `src/preload/bridge.ts` | 三個新頻道的接線 |
| `src/renderer/hooks/useApprovals.ts` | 除了自己的卡,另外回別的對話的卡 |
| `src/renderer/components/ApprovalCard.tsx` | 多一個來源標示與跳轉 |
| `src/renderer/components/ConversationPane.tsx` | 畫別的對話的卡;把 peer 狀態接給 Conversation |
| `src/renderer/components/Conversation.tsx` | 畫 `peer-question` 區塊 |
| `src/renderer/components/Turn.tsx` | 同伴提問那一輪標「同伴提問」 |
| `src/renderer/components/ToolCall.tsx` | `ask_peer` 等待中顯示已等秒數 |

---

### Task 1: 批准不再扣住

**Files:**
- Modify: `src/main/approval.ts`
- Modify: `src/main/conversation.ts`
- Modify: `src/main/ipc-bridge.ts`
- Test: `tests/approval.test.ts`(改)、`tests/conversation.test.ts`(改)、`tests/ipc-bridge.test.ts`(改)

**Interfaces:**
- Produces:
  - `APPROVAL_TIMEOUT_MS = 300_000`(`src/main/approval.ts` 匯出)
  - `Conversation.pendingApprovals(): number`(取代 `heldApprovals()`)
  - `ConversationDeps.onPendingApprovalsChange?: (count: number) => void`(取代 `onHeldChange`)

行為:

- 對話在背景時發出的批准不再扣住,一律進批准登錄表,payload 照舊帶 `projectId` 與 `conversationId`。
- 逾時預設值改 5 分鐘,只在 `approval.ts` 定義一次並匯出常數。
- 切 session 與收尾時原本 `denyHeld` 的地方改成 `registry.denyAll`。
- 待批准記號的來源從「扣住的數量」改成「批准登錄表裡屬於這個對話的數量」。

- [ ] **Step 1: 改逾時的失敗測試**

`tests/approval.test.ts` 裡原本斷言 30 秒的那條改成:

```ts
import { APPROVAL_TIMEOUT_MS, createApprovalRegistry } from '../src/main/approval.js'

it('預設逾時是 5 分鐘', () => {
  expect(APPROVAL_TIMEOUT_MS).toBe(300_000)
})
```

原本測逾時行為的那條(用假計時器推進 30_000 的那條)把數字換成 `APPROVAL_TIMEOUT_MS`,
訊息斷言跟著變成 `批准請求逾時（300000ms 內未收到回覆）`。不要新增第二條同樣的測試。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/approval.test.ts`
Expected: FAIL,`APPROVAL_TIMEOUT_MS` 不存在

- [ ] **Step 3: 改 approval.ts**

```ts
/**
 * 批准逾時。原本 30 秒,是在「卡片一定是你正在看的東西」的前提下選的;
 * D2 規格 §11 之後任何對話的卡都會出現在人眼前,30 秒對別的對話的卡太短。
 */
export const APPROVAL_TIMEOUT_MS = 300_000
```

`createApprovalRegistry` 裡 `const timeoutMs = options.timeoutMs ?? 30_000` 改成
`options.timeoutMs ?? APPROVAL_TIMEOUT_MS`。其餘不動。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/approval.test.ts`
Expected: PASS

- [ ] **Step 5: 寫 conversation 的失敗測試**

`tests/conversation.test.ts`。這個檔既有的 `setup()` 有 `heldCounts` 這個陣列在收
`onHeldChange` 的值,把它改名成 `pendingCounts` 收 `onPendingApprovalsChange`。
既有斷言「背景時批准被扣住」那幾條要改寫成新行為,不要留著兩套:

```ts
describe('批准不再扣住(D2 規格 §11)', () => {
  it('背景時的批准照樣送出去,不扣在主行程', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ASK)
    await flush()
    expect(rig.asks).toHaveLength(1)
    expect(rig.core.pendingApprovals()).toBe(1)
    rig.core.approvalReply(rig.asks[0]!.requestId, 'allow')
    expect(await outcome).toEqual({ decision: 'allow' })
    expect(rig.core.pendingApprovals()).toBe(0)
  })

  it('待批准數量變動時通知一次', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    void rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.approvalReply(rig.asks[0]!.requestId, 'deny')
    await flush()
    expect(rig.pendingCounts).toEqual([1, 0])
  })

  it('切到前景不會把同一筆批准再送一次', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    void rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.activate()
    await flush()
    expect(rig.asks).toHaveLength(1)
  })

  it('換 session 時把在等的批准全部拒絕', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.startNew()
    await flush()
    expect((await outcome).decision).toBe('deny')
    expect(rig.core.pendingApprovals()).toBe(0)
  })
})
```

`ASK` 用這個檔既有的批准請求 fixture;沒有的話在檔案上方加一個:

```ts
const ASK = { toolName: 'Bash', toolUseId: 'tu-1', input: { command: 'ls' }, title: '執行 ls' }
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/conversation.test.ts`
Expected: FAIL,`pendingApprovals` 不是函式

- [ ] **Step 7: 改 conversation.ts**

刪掉 `HeldAsk` 介面、`held`、`setHeld`、`releaseHeld`、`denyHeld` 這五樣。
`ConversationDeps` 的 `onHeldChange` 改名 `onPendingApprovalsChange`,註解改成
「待批准數量改變時通知(D2 規格 §11);路由器據此更新分頁列的待批准記號」。

`requestApproval` 改成:

```ts
  /** 待批准數量變了就通知一次。送出前後各推一次,renderer 的記號才跟得上。 */
  const notifyPending = (): void => {
    deps.onPendingApprovalsChange?.(registry.pendingCount())
  }
  /**
   * D2 規格 §11:不看自己是不是前景,一律進批准登錄表。背景時扣住的舊做法讓
   * 同伴問答一旦需要批准就卡住,而人不知道要切到哪裡去按。
   */
  const requestApproval = (request: ApprovalAsk): Promise<ApprovalOutcome> => {
    const outcome = registry.request(request)
    notifyPending()
    return outcome.finally(notifyPending)
  }
```

三處呼叫改掉:

- 原本 `denyHeld(MSG.sessionEnded)` 那一行改成 `registry.denyAll(MSG.sessionEnded)`,後面補 `notifyPending()`。
- 原本 `registry.denyAll(effect.reason)` 後面那行 `denyHeld(effect.reason)` 直接刪掉,補 `notifyPending()`。
- `activate()` 裡的 `releaseHeld()` 直接刪掉。
- `dispose()` 裡的 `denyHeld(WINDOW_CLOSED)` 改成 `registry.denyAll(WINDOW_CLOSED)`,後面補 `notifyPending()`。

對外介面 `heldApprovals(): number` 改成:

```ts
  /** 目前在等回覆的批准數。分頁列的待批准記號用它。 */
  pendingApprovals(): number
```

實作 `pendingApprovals: () => registry.pendingCount(),`。

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run tests/conversation.test.ts`
Expected: PASS

- [ ] **Step 9: 改 ipc-bridge**

`src/main/ipc-bridge.ts`:

```ts
        const pendingTabIds = tabIdsWhere(p, (core) => core.pendingApprovals() > 0)
```

`common` 裡 `onHeldChange: pushProjects` 改成 `onPendingApprovalsChange: pushProjects`。

`tests/ipc-bridge.test.ts` 裡假的對話核心有 `heldApprovals` 的地方一起改名,
既有那條驗待批准記號的測試沿用,只改方法名。

- [ ] **Step 10: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 11: Commit**

```bash
git add src/main/approval.ts src/main/conversation.ts src/main/ipc-bridge.ts tests/approval.test.ts tests/conversation.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: 批准不再扣住,逾時改五分鐘"
```

---

### Task 2: 別的對話的批准卡

**Files:**
- Modify: `src/renderer/hooks/useApprovals.ts`
- Modify: `src/renderer/components/ApprovalCard.tsx`
- Modify: `src/renderer/components/ApprovalCard.css`
- Modify: `src/renderer/components/ConversationPane.tsx`
- Test: `tests/approval-card.test.tsx`(改)、`tests/conversation-pane.test.tsx`(改)

**Interfaces:**
- Consumes:Task 1 之後,背景對話的批准會真的送到 renderer。
- Produces:
  - `Approvals.foreign: readonly ApprovalAskPayload[]`(不屬於目前對話的)
  - `ApprovalCardProps.origin?: { label: string; onJump: () => void }`

行為:

- `useApprovals` 除了 `pending`(目前對話的)之外,另外回 `foreign`(其餘全部,依到達順序)。
- `ConversationPane` 把 `foreign` 畫在自己的卡片之後,每張帶標示與跳轉。
- 標示文字是「<專案名> · <對話標籤>」;找不到對應的專案或分頁就退成「其他對話」。
- 點標示先切專案再切分頁。

- [ ] **Step 1: 寫 useApprovals 的失敗測試**

`tests/approvals.test.ts` 是純函式的測試,`useApprovals` 的測試放
`tests/use-approvals.test.tsx`(新檔,若已存在就加 describe):

```tsx
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useApprovals } from '../src/renderer/hooks/useApprovals.js'
import type { ApprovalAskPayload, YesChefApi } from '../src/shared/ipc.js'

const ask = (over: Partial<ApprovalAskPayload>): ApprovalAskPayload => ({
  requestId: 'r1', projectId: 'p1', conversationId: 'c1', toolName: 'Bash',
  toolUseId: 'tu1', input: {}, title: '執行 ls', ...over,
})

function fakeApi() {
  let emit: ((a: ApprovalAskPayload) => void) | null = null
  const api = {
    onApprovalAsk: (cb: (a: ApprovalAskPayload) => void) => { emit = cb; return () => {} },
    onApprovalSettled: () => () => {},
    onSessionState: () => () => {},
    replyApproval: () => {},
  } as unknown as YesChefApi
  return { api, send: (a: ApprovalAskPayload) => { act(() => emit?.(a)) } }
}

describe('useApprovals 的 foreign', () => {
  it('自己的進 pending,別的對話的進 foreign', () => {
    const f = fakeApi()
    const { result } = renderHook(() => useApprovals(f.api, 'c1'))
    f.send(ask({ requestId: 'r1', conversationId: 'c1' }))
    f.send(ask({ requestId: 'r2', conversationId: 'c2' }))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['r1'])
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r2'])
  })

  it('foreign 依到達順序,不分專案', () => {
    const f = fakeApi()
    const { result } = renderHook(() => useApprovals(f.api, 'c1'))
    f.send(ask({ requestId: 'r2', conversationId: 'c2', projectId: 'p2' }))
    f.send(ask({ requestId: 'r3', conversationId: 'c3', projectId: 'p1' }))
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r2', 'r3'])
  })

  it('沒有目前對話時全部算 foreign', () => {
    const f = fakeApi()
    const { result } = renderHook(() => useApprovals(f.api, null))
    f.send(ask({ requestId: 'r1', conversationId: 'c1' }))
    expect(result.current.pending).toEqual([])
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r1'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/use-approvals.test.tsx`
Expected: FAIL,`foreign` 是 undefined

- [ ] **Step 3: 改 useApprovals**

介面加一個欄位,註解說清楚它與 `pending` 的關係:

```ts
export interface Approvals {
  /** 目前這個對話的待決請求。 */
  readonly pending: readonly ApprovalAskPayload[]
  /**
   * 其他對話(含其他專案)的待決請求,依到達順序。D2 規格 §11:批准一律送到
   * 人正在看的畫面,不再扣住等人切過去。
   */
  readonly foreign: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}
```

`pending` 那個 `useMemo` 旁邊加:

```ts
  const foreign = useMemo(
    () => all.filter((a) => a.conversationId !== conversationId),
    [all, conversationId]
  )
```

回傳的物件加上 `foreign`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/use-approvals.test.tsx`
Expected: PASS

- [ ] **Step 5: 寫 ApprovalCard 的失敗測試**

`tests/approval-card.test.tsx` 加:

```tsx
describe('別的對話的批准卡', () => {
  it('有 origin 時畫出標示,點了呼叫 onJump', async () => {
    const onJump = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={() => {}} origin={{ label: 'proj5 · B', onJump }} />)
    const button = screen.getByRole('button', { name: 'proj5 · B' })
    await userEvent.click(button)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('沒有 origin 時不畫標示', () => {
    render(<ApprovalCard ask={ask()} onDecide={() => {}} />)
    expect(screen.queryByTestId('approval-origin')).toBeNull()
  })
})
```

`ask()` 沿用這個檔既有的 fixture 工廠;`render`、`screen`、`userEvent` 沿用既有 import。

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/approval-card.test.tsx`
Expected: FAIL,找不到那顆按鈕

- [ ] **Step 7: 改 ApprovalCard**

props 加:

```ts
  /**
   * 這張卡不屬於目前的對話(D2 規格 §11)。有值就在卡片頂端畫一個可點的來源標示,
   * 點了跳到那個專案與對話。
   */
  readonly origin?: { readonly label: string; readonly onJump: () => void }
```

卡片內容最上方加:

```tsx
      {origin === undefined ? null : (
        <button
          type="button"
          className="approval-origin"
          data-testid="approval-origin"
          onClick={origin.onJump}
        >
          {origin.label}
        </button>
      )}
```

`ApprovalCard.css` 加一條 `.approval-origin`,沿用這個檔既有的字級與顏色變數,
不要新增顏色常數。

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run tests/approval-card.test.tsx`
Expected: PASS

- [ ] **Step 9: 寫 ConversationPane 的失敗測試**

`tests/conversation-pane.test.tsx` 加:

```tsx
describe('別的對話的批准卡', () => {
  it('畫在自己的卡片之後,標示是專案名加對話標籤', async () => {
    const rig = renderPane({
      approvals: [
        ask({ requestId: 'mine', conversationId: 'c1' }),
        ask({ requestId: 'other', conversationId: 'c2', projectId: 'p1' }),
      ],
    })
    const cards = await screen.findAllByTestId('approval-card')
    expect(cards).toHaveLength(2)
    expect(screen.getByTestId('approval-origin')).toHaveTextContent('proj5 · B')
  })

  it('點標示先切專案再切分頁', async () => {
    const rig = renderPane({ approvals: [ask({ requestId: 'other', conversationId: 'c2', projectId: 'p2' })] })
    await userEvent.click(screen.getByTestId('approval-origin'))
    expect(rig.projects.activate).toHaveBeenCalledWith('p2')
    expect(rig.projects.activateTab).toHaveBeenCalledWith('c2')
  })

  it('找不到對應的專案或分頁時標示退成「其他對話」', async () => {
    renderPane({ approvals: [ask({ requestId: 'other', conversationId: 'nope', projectId: 'nope' })] })
    expect(screen.getByTestId('approval-origin')).toHaveTextContent('其他對話')
  })
})
```

`renderPane` 是這個檔既有的 helper;它現在要能塞進一組批准請求與一份 projects view
(裡面有專案 `p1`(名 proj5)含分頁 `c1`(標籤 A)與 `c2`(標籤 B),以及專案 `p2`)。
既有 helper 沒有這兩個入口就在原 helper 上加,不要另建一套。`approval-card` 這個
`data-testid` 若既有的卡片沒有,就在 `ApprovalCard` 根節點補上。

- [ ] **Step 10: 跑測試確認失敗**

Run: `npx vitest run tests/conversation-pane.test.tsx`
Expected: FAIL,只找得到一張卡

- [ ] **Step 11: 改 ConversationPane**

從 `useApprovals` 取出 `foreign`,在既有畫 `unmatched` 卡片那一段之後加:

```tsx
  /** 別的對話的卡:標示用專案名加對話標籤,兩者任一找不到就退成「其他對話」。 */
  const originOf = useCallback(
    (askPayload: ApprovalAskPayload) => {
      const project = projects.view?.projects.find((p) => p.id === askPayload.projectId)
      const tab = project?.tabs.find((t) => t.id === askPayload.conversationId)
      const label =
        project === undefined || tab === undefined
          ? '其他對話'
          : `${project.name} · ${tab.customLabel ?? tab.label}`
      return {
        label,
        onJump: (): void => {
          projects.activate(askPayload.projectId)
          projects.activateTab(askPayload.conversationId)
        },
      }
    },
    [projects]
  )
```

```tsx
            {foreign.map((a) => (
              <ApprovalCard key={a.requestId} ask={a} onDecide={reply} unmatched origin={originOf(a)} />
            ))}
```

`unmatched` 照樣給:這些卡片本來就對不到目前對話裡的任何 tool block。

- [ ] **Step 12: 跑測試確認通過**

Run: `npx vitest run tests/conversation-pane.test.tsx`
Expected: PASS

- [ ] **Step 13: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 14: Commit**

```bash
git add src/renderer/hooks/useApprovals.ts src/renderer/components/ApprovalCard.tsx src/renderer/components/ApprovalCard.css src/renderer/components/ConversationPane.tsx tests/use-approvals.test.tsx tests/approval-card.test.tsx tests/conversation-pane.test.tsx
git commit -m "feat: 別的對話的批准卡出現在目前畫面並可跳轉"
```

---

### Task 3: 同伴提問自成一輪

**Files:**
- Modify: `src/shared/peer-tools.ts`
- Modify: `src/main/peer/errors.ts`
- Modify: `src/shared/fold.ts`
- Modify: `src/renderer/components/Turn.tsx`
- Modify: `src/renderer/components/Conversation.tsx`
- Create: `src/renderer/components/PeerQuestion.tsx`
- Create: `src/renderer/components/PeerQuestion.css`
- Test: `tests/peer-injection-text.test.ts`(新)、`tests/peer-question-fold.test.ts`(新)、`tests/peer-question.test.tsx`(新)

**Interfaces:**
- Produces:
  - `interface PeerInjection { provider: string; fromLinkId: string; questionId: string; text: string }`
  - `formatPeerInjection(injection: PeerInjection): string`
  - `parsePeerInjection(raw: string): PeerInjection | null`
  - `Block` 多一種:`{ kind: 'peer-question'; questionId: string; fromLinkId: string; provider: string; text: string }`
  - `PeerQuestionProps { question: PeerInjection; status?: PeerQuestionStatus; onAnswer?: (text: string) => void; onCancel?: () => void }`
  - `type PeerQuestionStatus = { kind: 'waiting'; waitedSeconds: number } | { kind: 'answered' } | { kind: 'cancelled'; reason: string }`

設計:注入的文字只有一份定義,產生與解析放在一起。`fold.ts` 在 `applyUserText` 那個唯一入口
解析一次:認得出來就變成 `peer-question` 區塊,認不出來就照舊是文字。live 與歷史都走這裡,
不必兩套。這個 Task 只做「畫成一輪」,狀態與按鈕在 Task 6、7。

- [ ] **Step 1: 寫注入文字的失敗測試**

`tests/peer-injection-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatPeerInjection, parsePeerInjection, type PeerInjection } from '../src/shared/peer-tools.js'

const sample: PeerInjection = {
  provider: 'claude',
  fromLinkId: 'aaaa1111',
  questionId: 'q-1',
  text: '要用哪個欄位?',
}

describe('formatPeerInjection', () => {
  it('格式與規格 §6.1 一字不差', () => {
    expect(formatPeerInjection(sample)).toBe(
      '同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。答不出來也要回答「答不出來」加原因,不要不回。'
    )
  })

  it('fromLinkId 超過 8 碼時只取前 8 碼', () => {
    expect(formatPeerInjection({ ...sample, fromLinkId: 'aaaa1111-2222' })).toContain('(claude,aaaa1111)')
  })
})

describe('parsePeerInjection', () => {
  it('認得出自己產生的文字', () => {
    expect(parsePeerInjection(formatPeerInjection(sample))).toEqual(sample)
  })

  it('問題本身有換行也認得出來', () => {
    const multi = { ...sample, text: '第一行\n第二行' }
    expect(parsePeerInjection(formatPeerInjection(multi))).toEqual(multi)
  })

  it('問題裡有全形括號或冒號不影響解析', () => {
    const tricky = { ...sample, text: '用(哪個)欄位:name 還是 id?' }
    expect(parsePeerInjection(formatPeerInjection(tricky))).toEqual(tricky)
  })

  it('codex 的 provider 也認', () => {
    const c = { ...sample, provider: 'codex' }
    expect(parsePeerInjection(formatPeerInjection(c))).toEqual(c)
  })

  it('不是注入文字的一律回 null', () => {
    for (const raw of [
      '',
      '同伴提問:沒有括號',
      '同伴(claude,aaaa1111)提問:少了第二行',
      '前面多一段\n同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。答不出來也要回答「答不出來」加原因,不要不回。',
      '同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。',
    ]) {
      expect(parsePeerInjection(raw), raw).toBeNull()
    }
  })

  it('前 8 碼原樣回傳,不再截一次', () => {
    const parsed = parsePeerInjection(formatPeerInjection({ ...sample, fromLinkId: 'aaaa1111-2222' }))
    expect(parsed?.fromLinkId).toBe('aaaa1111')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-injection-text.test.ts`
Expected: FAIL,`formatPeerInjection` 不存在

- [ ] **Step 3: 寫注入文字的產生與解析**

`src/shared/peer-tools.ts` 追加(既有的常數不動):

```ts
/**
 * 注入給對方的提問(P 規格 §6.1)。產生與解析放在一起:`fold` 要靠解析把它畫成
 * 獨立一輪,而 live 與歷史拿到的都只是一段文字,沒有別的標記可用。格式改動時
 * 兩邊一起改,round-trip 的測試會擋住只改一邊。
 */
export interface PeerInjection {
  readonly provider: string
  /** 提問方 linkId 的前 8 碼。 */
  readonly fromLinkId: string
  readonly questionId: string
  readonly text: string
}

const INJECTION_TAIL = '。答不出來也要回答「答不出來」加原因,不要不回。'

export function formatPeerInjection(injection: PeerInjection): string {
  const from = injection.fromLinkId.slice(0, 8)
  return (
    `同伴(${injection.provider},${from})提問:${injection.text}\n` +
    `用 answer_peer 回答,id 是 ${injection.questionId}${INJECTION_TAIL}`
  )
}

const INJECTION_RE = new RegExp(
  '^同伴\\(([^,()]+),([^()]+)\\)提問:([\\s\\S]*)\\n用 answer_peer 回答,id 是 ([^\\s]+)' +
    INJECTION_TAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '$'
)

export function parsePeerInjection(raw: string): PeerInjection | null {
  const m = INJECTION_RE.exec(raw)
  if (m === null) return null
  const [, provider, fromLinkId, text, questionId] = m
  if (provider === undefined || fromLinkId === undefined || text === undefined || questionId === undefined) {
    return null
  }
  return { provider, fromLinkId, questionId, text }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/peer-injection-text.test.ts`
Expected: PASS

- [ ] **Step 5: 讓 PEER_MSG 用同一份**

`src/main/peer/errors.ts`:

```ts
import { formatPeerInjection } from '../../shared/peer-tools.js'
```

```ts
  /** 注入給對方的提問。格式與解析都在 shared/peer-tools.ts,這裡只是轉呼叫。 */
  injection: (provider: string, linkId: string, id: string, text: string) =>
    formatPeerInjection({ provider, fromLinkId: linkId, questionId: id, text }),
```

Run: `npx vitest run tests/peer-service.test.ts`
Expected: PASS(注入文字沒有變,既有斷言照樣過)

- [ ] **Step 6: 寫 fold 的失敗測試**

`tests/peer-question-fold.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fold } from '../src/shared/fold.js'
import { formatPeerInjection } from '../src/shared/peer-tools.js'
import type { Event } from '../src/shared/events.js'

const injected = formatPeerInjection({
  provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'q-1', text: '要用哪個欄位?',
})

describe('同伴提問自成一輪', () => {
  it('注入的提問變成 peer-question 區塊,不是文字', () => {
    const view = fold([{ kind: 'user-text', text: injected }] as readonly Event[])
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.role).toBe('user')
    expect(view.turns[0]?.blocks).toEqual([
      { kind: 'peer-question', questionId: 'q-1', fromLinkId: 'aaaa1111', provider: 'claude', text: '要用哪個欄位?' },
    ])
  })

  it('一般的使用者文字不受影響', () => {
    const view = fold([{ kind: 'user-text', text: '同伴(claude,aaaa1111)提問:少了第二行' }] as readonly Event[])
    expect(view.turns[0]?.blocks[0]).toEqual({ kind: 'text', markdown: '同伴(claude,aaaa1111)提問:少了第二行', complete: true })
  })

  it('提問與它前後的輪次各自獨立', () => {
    const view = fold([
      { kind: 'user-text', text: '你好' },
      { kind: 'user-text', text: injected },
      { kind: 'user-text', text: '再見' },
    ] as readonly Event[])
    expect(view.turns.map((t) => t.blocks[0]?.kind)).toEqual(['text', 'peer-question', 'text'])
  })
})
```

- [ ] **Step 7: 跑測試確認失敗**

Run: `npx vitest run tests/peer-question-fold.test.ts`
Expected: FAIL,區塊還是 `text`

- [ ] **Step 8: 改 fold**

`src/shared/fold.ts`:

```ts
import { parsePeerInjection } from './peer-tools.js'
```

`Block` 聯集加一種(接在 `compact-summary` 後面):

```ts
  | {
      readonly kind: 'peer-question'
      readonly questionId: string
      readonly fromLinkId: string
      readonly provider: string
      readonly text: string
    }
```

`applyUserText` 改成:

```ts
/**
 * 使用者文字。注入的同伴提問走的是同一條路(它在 SDK 眼裡就是一則 user 訊息),
 * 所以在這裡解析一次:認得出來就自成一輪畫成同伴提問,認不出來照舊是文字。
 * live 與歷史共用這一個入口,不必兩套規則(P 規格 §6.2)。
 */
function applyUserText(view: WorkingView, text: string): WorkingView {
  const injection = parsePeerInjection(text)
  if (injection === null) return applyUserTurn(view, { kind: 'text', markdown: text, complete: true })
  return applyUserTurn(view, {
    kind: 'peer-question',
    questionId: injection.questionId,
    fromLinkId: injection.fromLinkId,
    provider: injection.provider,
    text: injection.text,
  })
}
```

- [ ] **Step 9: 跑測試確認通過**

Run: `npx vitest run tests/peer-question-fold.test.ts tests/fold.test.ts`
Expected: 全部 PASS

- [ ] **Step 10: 寫元件的失敗測試**

`tests/peer-question.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PeerQuestion } from '../src/renderer/components/PeerQuestion.js'

const question = { provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'q-1', text: '要用哪個欄位?' }

describe('PeerQuestion', () => {
  it('畫出誰問的與問題本身', () => {
    render(<PeerQuestion question={question} />)
    expect(screen.getByText('要用哪個欄位?')).toBeInTheDocument()
    expect(screen.getByTestId('peer-from')).toHaveTextContent('claude · aaaa1111')
  })

  it('沒有給狀態時不畫狀態列', () => {
    render(<PeerQuestion question={question} />)
    expect(screen.queryByTestId('peer-status')).toBeNull()
  })
})
```

`Turn.tsx` 的標籤在 `tests/conversation.test.tsx` 加一條:

```tsx
  it('整輪只有同伴提問時角色標「同伴提問」', () => {
    renderConversation({
      turns: [{ role: 'user', blocks: [{ kind: 'peer-question', questionId: 'q-1', fromLinkId: 'aaaa1111', provider: 'claude', text: '在嗎' }] }],
    })
    expect(screen.getByText('同伴提問')).toBeInTheDocument()
    expect(screen.queryByText('你')).toBeNull()
  })
```

`renderConversation` 是這個檔既有的 helper,沿用。

- [ ] **Step 11: 跑測試確認失敗**

Run: `npx vitest run tests/peer-question.test.tsx tests/conversation.test.tsx`
Expected: FAIL,找不到 `PeerQuestion`

- [ ] **Step 12: 寫元件**

`src/renderer/components/PeerQuestion.tsx`:

```tsx
import type { PeerInjection } from '../../shared/peer-tools.js'
import './PeerQuestion.css'

export type PeerQuestionStatus =
  | { readonly kind: 'waiting'; readonly waitedSeconds: number }
  | { readonly kind: 'answered' }
  | { readonly kind: 'cancelled'; readonly reason: string }

export interface PeerQuestionProps {
  readonly question: PeerInjection
  /** 沒有給就不畫狀態列:歷史檢視拿不到狀態時就是這樣。 */
  readonly status?: PeerQuestionStatus
}

function statusText(status: PeerQuestionStatus): string {
  if (status.kind === 'waiting') return `等你回答,對方已等 ${String(status.waitedSeconds)} 秒`
  if (status.kind === 'answered') return '已回答'
  return `已取消:${status.reason}`
}

/** 同伴提問自成一輪(P 規格 §6.2)。這一版只畫內容與狀態,兩顆介入按鈕在 Task 6 接上。 */
export function PeerQuestion({ question, status }: PeerQuestionProps) {
  return (
    <section className="peer-question">
      <div className="peer-question-head" data-testid="peer-from">
        {question.provider} · {question.fromLinkId}
      </div>
      <div className="peer-question-text">{question.text}</div>
      {status === undefined ? null : (
        <div className="peer-question-status" data-testid="peer-status">{statusText(status)}</div>
      )}
    </section>
  )
}
```

`src/renderer/components/PeerQuestion.css`:沿用既有元件的變數與字級,
`.peer-question` 給一條左邊框與淡背景,`.peer-question-head` 用小字與次要顏色。
不要新增顏色常數。

`src/renderer/components/Turn.tsx`:

```tsx
/**
 * 壓縮摘要與同伴提問的 role 都是 user,但都不是使用者說的話。整個 turn 只有那一種
 * 區塊時換標籤,否則畫面會把它們掛在「你」名下。
 */
function roleLabel(turn: TurnModel): string {
  const only = (kind: string): boolean => turn.blocks.length > 0 && turn.blocks.every((b) => b.kind === kind)
  if (only('compact-summary')) return '系統'
  if (only('peer-question')) return '同伴提問'
  return ROLE_LABEL[turn.role]
}
```

既有的 `onlySummary` 那段用這個版本取代,不要兩套。

`src/renderer/components/Conversation.tsx` 畫區塊的 switch 加一支:

```tsx
      case 'peer-question':
        return <PeerQuestion key={index} question={block} />
```

`block` 的欄位名與 `PeerInjection` 一致,可以直接傳。

- [ ] **Step 13: 跑測試確認通過**

Run: `npx vitest run tests/peer-question.test.tsx tests/conversation.test.tsx`
Expected: PASS

- [ ] **Step 14: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 15: Commit**

```bash
git add src/shared/peer-tools.ts src/shared/fold.ts src/main/peer/errors.ts src/renderer/components/PeerQuestion.tsx src/renderer/components/PeerQuestion.css src/renderer/components/Turn.tsx src/renderer/components/Conversation.tsx tests/peer-injection-text.test.ts tests/peer-question-fold.test.ts tests/peer-question.test.tsx tests/conversation.test.tsx
git commit -m "feat: 同伴的提問在畫面上自成一輪"
```

---

### Task 4: ask_peer 顯示已等秒數

**Files:**
- Create: `src/renderer/elapsed.ts`
- Modify: `src/renderer/components/ToolCall.tsx`
- Test: `tests/elapsed.test.tsx`(新)、`tests/tool-call.test.tsx`(改;沒有這個檔就建)

**Interfaces:**
- Consumes:`ASK_PEER_TOOL`(`src/shared/peer-tools.ts`,第一階段就有)。
- Produces:`useElapsedSeconds(active: boolean): number`

行為:`ask_peer` 的 tool block 在 `running` 時,狀態字改成「等同伴回答,已等 n 秒」,
每秒更新一次。block 離開 `running` 就停。秒數由元件自己算,不新增事件也不新增 IPC:
這個數字只是給人看的,不必跨程序同步。

- [ ] **Step 1: 寫失敗測試**

`tests/elapsed.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useElapsedSeconds } from '../src/renderer/elapsed.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useElapsedSeconds', () => {
  it('active 時每秒加一', () => {
    const { result } = renderHook(() => useElapsedSeconds(true))
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(result.current).toBe(3)
  })

  it('active 是 false 時固定回 0,也不起計時器', () => {
    const { result } = renderHook(() => useElapsedSeconds(false))
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(result.current).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('從 active 變成不 active 時歸零並停掉計時器', () => {
    const { result, rerender } = renderHook(({ a }: { a: boolean }) => useElapsedSeconds(a), {
      initialProps: { a: true },
    })
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(result.current).toBe(2)
    rerender({ a: false })
    expect(result.current).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸載時停掉計時器', () => {
    const { unmount } = renderHook(() => useElapsedSeconds(true))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

`tests/tool-call.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolCall } from '../src/renderer/components/ToolCall.js'
import { ASK_PEER_TOOL } from '../src/shared/peer-tools.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'

const block = (over: Partial<ToolBlock>): ToolBlock => ({
  kind: 'tool', id: 't1', name: 'Bash', input: {}, status: 'running', ...over,
} as ToolBlock)

describe('ask_peer 的等待狀態', () => {
  it('執行中時狀態字是「等同伴回答,已等 0 秒」', () => {
    render(<ToolCall block={block({ name: ASK_PEER_TOOL })} historical={false} />)
    expect(screen.getByText('等同伴回答，已等 0 秒')).toBeInTheDocument()
  })

  it('完成之後回到一般狀態字', () => {
    render(<ToolCall block={block({ name: ASK_PEER_TOOL, status: 'done' })} historical={false} />)
    expect(screen.getByText('完成')).toBeInTheDocument()
  })

  it('別的工具執行中還是「執行中」', () => {
    render(<ToolCall block={block({ name: 'Bash' })} historical={false} />)
    expect(screen.getByText('執行中')).toBeInTheDocument()
  })
})
```

注意:狀態字裡的逗號用全形「，」,與 `STATUS_LABEL` 既有文案的標點一致。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/elapsed.test.tsx tests/tool-call.test.tsx`
Expected: FAIL,`useElapsedSeconds` 不存在

- [ ] **Step 3: 寫 hook**

`src/renderer/elapsed.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * 從 `active` 變成 true 那一刻起算的秒數,每秒更新一次;不 active 時固定 0 且不起計時器。
 * 只給人看的數字,不跨程序同步:等待的真相在主行程的信箱裡,畫面上這個數字掉一秒
 * 不影響任何決定。
 */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!active) {
      setSeconds(0)
      return
    }
    setSeconds(0)
    const timer = setInterval(() => { setSeconds((prev) => prev + 1) }, 1_000)
    return () => { clearInterval(timer) }
  }, [active])

  return seconds
}
```

- [ ] **Step 4: 改 ToolCall**

```tsx
import { ASK_PEER_TOOL } from '../../shared/peer-tools.js'
import { useElapsedSeconds } from '../elapsed.js'
```

```tsx
function ToolCallImpl({ block, historical, renderExtra }: ToolCallProps) {
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const open = override ?? block.status === 'awaiting-approval'
  const settled = block.status === 'done' || block.status === 'error'
  /** ask_peer 會等到 10 分鐘,只寫「執行中」看不出還要不要等(P 規格 §6.2)。 */
  const waiting = block.name === ASK_PEER_TOOL && block.status === 'running'
  const waited = useElapsedSeconds(waiting)
  const statusLabel = waiting ? `等同伴回答，已等 ${String(waited)} 秒` : STATUS_LABEL[block.status]
```

`<span className="tool-status">` 的內容改成 `{statusLabel}`。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/elapsed.test.tsx tests/tool-call.test.tsx`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/elapsed.ts src/renderer/components/ToolCall.tsx tests/elapsed.test.tsx tests/tool-call.test.tsx
git commit -m "feat: ask_peer 等待時顯示已等秒數"
```

---

### Task 5: 未決問題的狀態出口

**Files:**
- Modify: `src/main/peer/service.ts`
- Test: `tests/peer-service.test.ts`(加)

**Interfaces:**
- Consumes:第一階段的 `PeerService`、`Waiting`、`Mailbox`。
- Produces:
  - `interface PeerPending { questionId: string; projectId: string; askerConversationId: string; targetConversationId: string; askerLinkId: string; text: string; createdAt: number; queued: boolean }`
  - `PeerService.pending(): readonly PeerPending[]`
  - `PeerService.onChange(listener: () => void): () => void`
  - `PeerService.answerAsUser(questionId: string, text: string): Promise<void>`
  - `PeerService.cancelAsUser(questionId: string): Promise<void>`
  - `PEER_MSG.userCancelled = '使用者取消'`、`PEER_MSG.pendingUnknown(id)`

行為(P 規格 §6.5):

- `pending()` 回目前所有未決問題的快照,依 `createdAt` 排序。取消中的不列。
- `onChange` 在未決集合有增減時通知,回一個取消訂閱的函式。加、收掉、排隊狀態改變都要通知。
- `answerAsUser`:人代替對方回答。寫的 answer `from` 沿用原問題的 `to`,`actor` 是 `'user'`,
  接著跟 `answer_peer` 走同一條路把等待方喚醒。找不到那則未決問題就丟 `PeerError`。
- `cancelAsUser`:寫 cancel,原因「使用者取消」,`actor` 是 `'user'`,`ask_peer` 立刻以那個原因結束。

- [ ] **Step 1: 寫失敗測試**

`tests/peer-service.test.ts` 追加(沿用這個檔既有的 `setup`、`flush` 與假時鐘):

```ts
describe('未決問題的快照與通知', () => {
  it('pending 列出未決的那些,依 createdAt 排序', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    expect(r.service.pending()).toEqual([
      expect.objectContaining({
        questionId: 'id-1',
        projectId: 'alpha',
        askerConversationId: 'A',
        targetConversationId: 'B',
        askerLinkId: 'aaaa1111',
        text: '第一題',
        queued: false,
      }),
    ])
  })

  it('回答之後就不在 pending 裡', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    expect(r.service.pending()).toEqual([])
  })

  it('排隊中的也列出來,queued 是 true', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    void r.service.forConversation('A').askPeer('排隊中')
    await flush()
    expect(r.service.pending()[0]?.queued).toBe(true)
  })

  it('onChange 在加入與收掉時各通知一次,取消訂閱後不再通知', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    let count = 0
    const off = r.service.onChange(() => { count += 1 })
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    const afterAsk = count
    expect(afterAsk).toBeGreaterThan(0)
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    expect(count).toBeGreaterThan(afterAsk)
    off()
    const afterOff = count
    void r.service.forConversation('A').askPeer('第二題')
    await flush()
    expect(count).toBe(afterOff)
  })
})

describe('人的介入', () => {
  it('代替回答:answer 的 from 是原問題的 to,actor 是 user,提問方拿到那段文字', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.answerAsUser('id-1', '我幫他答')
    expect(await pending).toBe('我幫他答')
    const answer = JSON.parse(
      [...r.files.entries()].find(([k]) => k.endsWith('answer-id-2.json'))![1]
    ) as { from: { linkId: string }; to: { linkId: string }; actor: string; text: string }
    expect(answer.from.linkId).toBe('bbbb2222')
    expect(answer.to.linkId).toBe('aaaa1111')
    expect(answer.actor).toBe('user')
    expect(answer.text).toBe('我幫他答')
  })

  it('取消:cancel 的原因是使用者取消,actor 是 user,ask_peer 立刻以那個原因結束', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.cancelAsUser('id-1')
    await expect(pending).rejects.toThrow(PEER_MSG.userCancelled)
    const cancel = JSON.parse(
      [...r.files.entries()].find(([k]) => k.endsWith('cancel-id-2.json'))![1]
    ) as { actor: string; text: string; from: { linkId: string } }
    expect(cancel.actor).toBe('user')
    expect(cancel.text).toBe(PEER_MSG.userCancelled)
    expect(cancel.from.linkId).toBe('bbbb2222')
  })

  it('找不到那則未決問題時丟錯,不寫檔', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const before = r.files.size
    await expect(r.service.answerAsUser('nope', 'x')).rejects.toThrow(PEER_MSG.pendingUnknown('nope'))
    await expect(r.service.cancelAsUser('nope')).rejects.toThrow(PEER_MSG.pendingUnknown('nope'))
    expect(r.files.size).toBe(before)
  })

  it('已經回答過的不能再代替回答', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    await expect(r.service.answerAsUser('id-1', '太晚了')).rejects.toThrow(PEER_MSG.pendingUnknown('id-1'))
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-service.test.ts`
Expected: FAIL,`pending` 不是函式

- [ ] **Step 3: 加訊息**

`src/main/peer/errors.ts` 的 `PEER_MSG` 加兩句(放在既有的 cancel 原因那一組旁邊):

```ts
  /** 人主動取消一則提問(規格 §6.5)。 */
  userCancelled: '使用者取消',
  /** 人要介入的那則問題已經不在未決集合裡(答過了、取消了、或根本沒有)。 */
  pendingUnknown: (id: string) => `沒有在等回答的問題 #${id}`,
```

- [ ] **Step 4: 改 service**

`src/main/peer/service.ts`:

```ts
/** 一則未決問題對外的樣子。給畫面用,不含 promise 的收尾函式。 */
export interface PeerPending {
  readonly questionId: string
  readonly projectId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  /** 提問方的 linkId,畫面上顯示前 8 碼。 */
  readonly askerLinkId: string
  readonly text: string
  readonly createdAt: number
  /** 還沒注入(對方回合進行中)。 */
  readonly queued: boolean
}
```

`PeerService` 介面加四個成員:

```ts
  /** 目前所有未決問題,依 createdAt 排序。取消中的不列。 */
  pending(): readonly PeerPending[]
  /** 未決集合有變動時通知。回傳取消訂閱的函式。 */
  onChange(listener: () => void): () => void
  /** 人代替同伴回答(規格 §6.5)。 */
  answerAsUser(questionId: string, text: string): Promise<void>
  /** 人取消一則提問(規格 §6.5)。 */
  cancelAsUser(questionId: string): Promise<void>
```

實作。先在 `createPeerService` 裡加監聽者集合與通知:

```ts
  let listeners: readonly (() => void)[] = []
  const notifyChange = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (cause) {
        deps.logError(new Error(`同伴狀態通知失敗:${messageOf(cause)}`))
      }
    }
  }
```

`waiting` 這個 Map 每次被換掉之後都要通知。既有的寫法是散在 `askPeer`、`inject`、
`settle` 三處各自 `waiting = new Map(...)`,改成統一走一個函式:

```ts
  /** 換掉 waiting 並通知。所有寫入都走這裡,漏一處畫面就不會更新。 */
  const setWaiting = (next: Map<string, Waiting>): void => {
    waiting = next
    notifyChange()
  }
```

把 `waiting = new Map([...])` 與 `waiting.delete(...)`／`waiting.set(...)` 那幾處全部改成
`setWaiting(new Map([...]))`。`settle` 裡刪除那一處也一樣。

快照:

```ts
    pending: () =>
      [...waiting.values()]
        .filter((w) => w.cancelling !== true)
        .map((w) => ({
          questionId: w.questionId,
          projectId: w.projectId,
          askerConversationId: w.askerConversationId,
          targetConversationId: w.targetConversationId,
          askerLinkId: w.question.from.linkId,
          text: w.question.text,
          createdAt: w.question.createdAt,
          queued: w.queued,
        }))
        .sort((a, b) => a.createdAt - b.createdAt),

    onChange(listener) {
      listeners = [...listeners, listener]
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },
```

兩個介入動作。它們與 `answerPeer`／`cancelQuestion` 的差別只有 `actor`,所以共用既有的
信箱寫入與喚醒,不要另寫一條路:

```ts
    /**
     * 人代替同伴回答(規格 §6.5)。`from` 沿用原問題的 `to`,所以 provider 是對方的;
     * `actor` 記 'user',信箱裡看得出這是人寫的,不是同伴寫的。
     */
    async answerAsUser(questionId, text) {
      const w = waiting.get(questionId)
      if (w === undefined || w.cancelling === true) throw new PeerError(PEER_MSG.pendingUnknown(questionId))
      await deps.mailboxFor(w.projectId, w.rootPath).write(
        newAnswer({ id: deps.newId(), question: w.question, text, actor: 'user', now: deps.clock.now() })
      )
      settle(questionId, (x) => x.resolve(text))
    },

    /** 人取消一則提問(規格 §6.5)。方向與逾時那一種相同,只有 actor 不同。 */
    async cancelAsUser(questionId) {
      const w = waiting.get(questionId)
      if (w === undefined || w.cancelling === true) throw new PeerError(PEER_MSG.pendingUnknown(questionId))
      await cancelQuestion(w, PEER_MSG.userCancelled, 'user')
    },
```

`settle` 本身已經會把那一筆從 `waiting` 拿掉並收掉 promise,通知由 `setWaiting` 帶出去。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/peer-service.test.ts`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/peer/service.ts src/main/peer/errors.ts tests/peer-service.test.ts
git commit -m "feat: 同伴服務對外提供未決問題與人的介入"
```

---

### Task 6: 未決問題推到畫面,兩顆按鈕接上

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/bridge.ts`
- Modify: `src/main/ipc-bridge.ts`
- Modify: `src/main/index.ts`
- Create: `src/renderer/hooks/usePeer.ts`
- Modify: `src/renderer/components/PeerQuestion.tsx`
- Modify: `src/renderer/components/Conversation.tsx`
- Modify: `src/renderer/components/ConversationPane.tsx`
- Test: `tests/ipc.test.ts`(改)、`tests/preload-bridge.test.ts`(改)、`tests/ipc-bridge.test.ts`(加)、`tests/use-peer.test.tsx`(新)、`tests/peer-question.test.tsx`(加)

**Interfaces:**
- Consumes:Task 5 的 `PeerPending`、`pending()`、`onChange`、`answerAsUser`、`cancelAsUser`;Task 3 的 `PeerQuestion` 元件。
- Produces:
  - `IPC.peerState = 'peer:state'`、`IPC.peerAnswer = 'peer:answer'`、`IPC.peerCancel = 'peer:cancel'`
  - `interface PeerStatePayload { pending: readonly PeerPendingView[] }`
  - `interface PeerPendingView { questionId, projectId, askerConversationId, targetConversationId, askerLinkId, text, createdAt, queued }`
  - `interface PeerActionPayload { questionId: string; text?: string }`
  - `YesChefApi.onPeerState`、`YesChefApi.answerPeerAsUser`、`YesChefApi.cancelPeer`
  - `usePeer(api): { pending: readonly PeerPendingView[]; answer(id, text): void; cancel(id): void }`

行為:

- 主行程在未決集合變動時整份重推,與 `projects:state` 同一個做法(整份推,不做增量)。
- renderer 收下全部,元件自己挑出與自己那一輪有關的那一則。
- 兩顆按鈕只在那則問題還未決時出現;送出後按鈕消失(下一次推送就沒有那一則了)。

- [ ] **Step 1: 寫 IPC 與 preload 的失敗測試**

`tests/ipc.test.ts` 加:

```ts
it('同伴問答的三個頻道名稱', () => {
  expect(IPC.peerState).toBe('peer:state')
  expect(IPC.peerAnswer).toBe('peer:answer')
  expect(IPC.peerCancel).toBe('peer:cancel')
})

it('parsePeerAction 只收得下形狀正確的 payload', () => {
  expect(parsePeerAction({ questionId: 'q1' })).toEqual({ questionId: 'q1' })
  expect(parsePeerAction({ questionId: 'q1', text: '答案' })).toEqual({ questionId: 'q1', text: '答案' })
  expect(parsePeerAction({ questionId: '' })).toBeNull()
  expect(parsePeerAction({ questionId: 'q1', text: 3 })).toBeNull()
  expect(parsePeerAction(null)).toBeNull()
  expect(parsePeerAction('q1')).toBeNull()
})
```

`tests/preload-bridge.test.ts` 加(沿用這個檔既有的假 `ipcRenderer`):

```ts
it('onPeerState 訂閱 peer:state,回傳的函式取消訂閱', () => {
  const off = api.onPeerState(() => {})
  expect(ipcRenderer.on).toHaveBeenCalledWith('peer:state', expect.any(Function))
  off()
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith('peer:state', expect.any(Function))
})

it('兩個動作送出對應的頻道與 payload', () => {
  api.answerPeerAsUser({ questionId: 'q1', text: '答案' })
  expect(ipcRenderer.send).toHaveBeenCalledWith('peer:answer', { questionId: 'q1', text: '答案' })
  api.cancelPeer({ questionId: 'q1' })
  expect(ipcRenderer.send).toHaveBeenCalledWith('peer:cancel', { questionId: 'q1' })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc.test.ts tests/preload-bridge.test.ts`
Expected: FAIL,`IPC.peerState` 是 undefined

- [ ] **Step 3: 加頻道與型別**

`src/shared/ipc.ts` 的 `IPC` 加三個(接在既有頻道之後):

```ts
  /** main → renderer:目前所有未決的同伴提問,整份重推 */
  peerState: 'peer:state',
  /** renderer → main:人代替同伴回答一則提問 */
  peerAnswer: 'peer:answer',
  /** renderer → main:人取消一則提問 */
  peerCancel: 'peer:cancel',
```

型別與解析:

```ts
/** 一則未決的同伴提問,給畫面用(P 規格 §6.5)。 */
export interface PeerPendingView {
  readonly questionId: string
  readonly projectId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  readonly askerLinkId: string
  readonly text: string
  readonly createdAt: number
  readonly queued: boolean
}

export interface PeerStatePayload {
  readonly pending: readonly PeerPendingView[]
}

/** 人的兩個動作共用一個形狀:取消不帶 text,代替回答帶。 */
export interface PeerActionPayload {
  readonly questionId: string
  readonly text?: string
}

export function parsePeerAction(raw: unknown): PeerActionPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['questionId'])) return null
  const text = raw['text']
  if (text !== undefined && typeof text !== 'string') return null
  return text === undefined ? { questionId: raw['questionId'] } : { questionId: raw['questionId'], text }
}
```

`YesChefApi` 加三個成員:

```ts
  onPeerState(cb: (state: PeerStatePayload) => void): () => void
  answerPeerAsUser(payload: PeerActionPayload): void
  cancelPeer(payload: PeerActionPayload): void
```

`src/preload/bridge.ts` 照既有寫法接上這三個。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/ipc.test.ts tests/preload-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: 寫 ipc-bridge 的失敗測試**

`tests/ipc-bridge.test.ts` 加(沿用既有的假 peer service,補上新成員):

```ts
describe('同伴未決狀態', () => {
  it('peer.onChange 觸發時整份推 peer:state', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    peer.setPending([
      { questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2',
        askerLinkId: 'aaaa1111', text: '在嗎', createdAt: 1, queued: false },
    ])
    peer.fireChange()
    expect(h.sent(IPC.peerState)).toEqual([{ pending: peer.pendingValue }])
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
    expect(h.errors.some((e) => e.message.includes(IPC.peerAnswer))).toBe(true)
  })

  it('收到 peer:cancel 就呼叫 cancelAsUser', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.emit(IPC.peerCancel, { questionId: 'q1' })
    expect(peer.cancelled).toEqual(['q1'])
  })

  it('服務丟錯時記錯誤,不讓例外跑出去', async () => {
    const peer = fakePeerService({ failAnswer: true })
    const h = await harnessWithPeer(peer.service)
    h.emit(IPC.peerAnswer, { questionId: 'q1', text: 'x' })
    await flush()
    expect(h.errors.some((e) => e.message.includes('q1'))).toBe(true)
  })

  it('沒給 peer 時三個頻道都不註冊,送進來也不會炸', async () => {
    const h = await harnessWithPeer(undefined)
    expect(() => { h.emit(IPC.peerAnswer, { questionId: 'q1', text: 'x' }) }).not.toThrow()
  })
})
```

`fakePeerService` 是這個檔在第一階段就有的 helper,補上 `pending()`、`onChange`、
`answerAsUser`、`cancelAsUser` 四個成員與 `setPending`／`fireChange`／`answered`／
`cancelled` 幾個觀察點;`h.sent(channel)`、`h.emit(channel, payload)`、`h.errors` 沿用既有 harness 的做法,
沒有就在既有 harness 上補,不要另建一套。

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL,沒有推 `peer:state`

- [ ] **Step 7: 改 ipc-bridge**

```ts
  /** 未決的同伴提問整份重推。與 projects:state 同一個做法:整份推,不做增量。 */
  const pushPeer = (): void => {
    if (deps.peer === undefined) return
    const payload: PeerStatePayload = { pending: deps.peer.pending() }
    sendBestEffort(IPC.peerState, payload)
  }
```

在建立 bridge 時訂閱,並在 `dispose` 取消:

```ts
  const offPeerChange = deps.peer?.onChange(pushPeer)
```

```ts
    offPeerChange?.()
```

兩個 handler:

```ts
  const onPeerAnswer = (_event: unknown, raw: unknown): void =>
    guard(IPC.peerAnswer, () => {
      const payload = parsePeerAction(raw)
      if (payload === null || payload.text === undefined) {
        deps.logError(rejectPayload(IPC.peerAnswer, raw))
        return
      }
      const text = payload.text
      deps.peer?.answerAsUser(payload.questionId, text)
        .catch((cause: unknown) => deps.logError(asError(cause, `${IPC.peerAnswer}(${payload.questionId})`)))
    })

  const onPeerCancel = (_event: unknown, raw: unknown): void =>
    guard(IPC.peerCancel, () => {
      const payload = parsePeerAction(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.peerCancel, raw))
        return
      }
      deps.peer?.cancelAsUser(payload.questionId)
        .catch((cause: unknown) => deps.logError(asError(cause, `${IPC.peerCancel}(${payload.questionId})`)))
    })
```

照既有做法在建立時 `ipcMain.on`,在 `dispose` 時 `removeListener`。
`guard`、`rejectPayload`、`asError` 都是這個檔既有的工具。

`src/main/index.ts` 不必改:`peer` 已經傳給 `createIpcBridge` 了。若 typecheck 指出
`PeerService` 的新成員在 index 用不到,那就是不必改。

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: PASS

- [ ] **Step 9: 寫 usePeer 的失敗測試**

`tests/use-peer.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePeer } from '../src/renderer/hooks/usePeer.js'
import type { PeerPendingView, YesChefApi } from '../src/shared/ipc.js'

const item = (over: Partial<PeerPendingView> = {}): PeerPendingView => ({
  questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2',
  askerLinkId: 'aaaa1111', text: '在嗎', createdAt: 1, queued: false, ...over,
})

function fakeApi() {
  let emit: ((s: { pending: readonly PeerPendingView[] }) => void) | null = null
  const answer = vi.fn()
  const cancel = vi.fn()
  const api = {
    onPeerState: (cb: (s: { pending: readonly PeerPendingView[] }) => void) => { emit = cb; return () => {} },
    answerPeerAsUser: answer,
    cancelPeer: cancel,
  } as unknown as YesChefApi
  return { api, answer, cancel, push: (p: readonly PeerPendingView[]) => { act(() => emit?.({ pending: p })) } }
}

describe('usePeer', () => {
  it('一開始是空的', () => {
    const { result } = renderHook(() => usePeer(fakeApi().api))
    expect(result.current.pending).toEqual([])
  })

  it('收到推送就整份換掉', () => {
    const f = fakeApi()
    const { result } = renderHook(() => usePeer(f.api))
    f.push([item()])
    expect(result.current.pending).toEqual([item()])
    f.push([])
    expect(result.current.pending).toEqual([])
  })

  it('兩個動作送出對應的 payload', () => {
    const f = fakeApi()
    const { result } = renderHook(() => usePeer(f.api))
    act(() => { result.current.answer('q1', '我幫他答') })
    expect(f.answer).toHaveBeenCalledWith({ questionId: 'q1', text: '我幫他答' })
    act(() => { result.current.cancel('q1') })
    expect(f.cancel).toHaveBeenCalledWith({ questionId: 'q1' })
  })
})
```

- [ ] **Step 10: 跑測試確認失敗**

Run: `npx vitest run tests/use-peer.test.tsx`
Expected: FAIL,找不到 `usePeer`

- [ ] **Step 11: 寫 usePeer**

`src/renderer/hooks/usePeer.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PeerPendingView, YesChefApi } from '../../shared/ipc.js'

export interface Peer {
  /** 目前所有未決的同伴提問(所有專案)。元件自己挑出與自己有關的那一則。 */
  readonly pending: readonly PeerPendingView[]
  answer(questionId: string, text: string): void
  cancel(questionId: string): void
}

/**
 * 未決的同伴提問:主行程 `PeerService` 的鏡像。整份重推,不做增量:未決問題的數量
 * 是個位數,增量的複雜度換不到什麼。
 */
export function usePeer(api: YesChefApi): Peer {
  const [pending, setPending] = useState<readonly PeerPendingView[]>([])

  useEffect(() => api.onPeerState((state) => { setPending(state.pending) }), [api])

  const answer = useCallback(
    (questionId: string, text: string): void => { api.answerPeerAsUser({ questionId, text }) },
    [api]
  )
  const cancel = useCallback(
    (questionId: string): void => { api.cancelPeer({ questionId }) },
    [api]
  )

  return useMemo(() => ({ pending, answer, cancel }), [pending, answer, cancel])
}
```

- [ ] **Step 12: 跑測試確認通過**

Run: `npx vitest run tests/use-peer.test.tsx`
Expected: PASS

- [ ] **Step 13: 寫按鈕的失敗測試**

`tests/peer-question.test.tsx` 加:

```tsx
describe('人的介入', () => {
  it('未決時畫出兩顆按鈕,取消直接呼叫', async () => {
    const onCancel = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 3 }} onAnswer={() => {}} onCancel={onCancel} />)
    expect(screen.getByTestId('peer-status')).toHaveTextContent('等你回答，對方已等 3 秒')
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('代替回答:按下之後出現輸入框,送出把文字交出去', async () => {
    const onAnswer = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} onAnswer={onAnswer} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '代替回答' }))
    await userEvent.type(screen.getByRole('textbox', { name: '代替回答的內容' }), '我幫他答')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(onAnswer).toHaveBeenCalledWith('我幫他答')
  })

  it('空白的代替回答不送出', async () => {
    const onAnswer = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} onAnswer={onAnswer} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '代替回答' }))
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('沒有給兩個回呼時不畫按鈕', () => {
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} />)
    expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  })
})
```

- [ ] **Step 14: 跑測試確認失敗**

Run: `npx vitest run tests/peer-question.test.tsx`
Expected: FAIL,找不到那兩顆按鈕

- [ ] **Step 15: 元件加上兩顆按鈕**

`src/renderer/components/PeerQuestion.tsx` props 加:

```ts
  /** 兩個都給才畫按鈕:人的介入(規格 §6.5)。歷史檢視不給。 */
  readonly onAnswer?: (text: string) => void
  readonly onCancel?: () => void
```

```tsx
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState('')
  const canAct = onAnswer !== undefined && onCancel !== undefined && status?.kind === 'waiting'
```

狀態列之後畫:

```tsx
      {!canAct ? null : (
        <div className="peer-question-actions">
          {drafting ? (
            <>
              <textarea
                className="peer-question-draft"
                aria-label="代替回答的內容"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const trimmed = draft.trim()
                  if (trimmed === '') return
                  onAnswer(trimmed)
                  setDraft('')
                  setDrafting(false)
                }}
              >
                送出
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setDrafting(true)}>代替回答</button>
          )}
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      )}
```

- [ ] **Step 16: 接上 Conversation 與 ConversationPane**

`Conversation.tsx` 的 props 加一個選用的 `peerFor?: (questionId: string) => { status?: PeerQuestionStatus; onAnswer?: (text: string) => void; onCancel?: () => void }`,
畫 `peer-question` 時把它的結果展開下去:

```tsx
      case 'peer-question': {
        const extra = peerFor?.(block.questionId) ?? {}
        return <PeerQuestion key={index} question={block} {...extra} />
      }
```

`ConversationPane.tsx`:

```tsx
  const peer = usePeer(api)
  /** 這個對話是回答方時才給按鈕:提問方那邊的介入掛在 ask_peer 的 tool block 上(Task 7)。 */
  const peerFor = useCallback(
    (questionId: string) => {
      const item = peer.pending.find((p) => p.questionId === questionId)
      if (item === undefined) return {}
      return {
        status: { kind: 'waiting' as const, waitedSeconds: 0 },
        onAnswer: (text: string) => { peer.answer(questionId, text) },
        onCancel: () => { peer.cancel(questionId) },
      }
    },
    [peer]
  )
```

`waitedSeconds` 這一版先給 0,Task 7 換成真的秒數。把 `peerFor` 傳給 `Conversation`。

- [ ] **Step 17: 跑測試確認通過**

Run: `npx vitest run tests/peer-question.test.tsx tests/conversation-pane.test.tsx`
Expected: PASS

- [ ] **Step 18: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 19: Commit**

```bash
git add src/shared/ipc.ts src/preload/bridge.ts src/main/ipc-bridge.ts src/renderer/hooks/usePeer.ts src/renderer/components/PeerQuestion.tsx src/renderer/components/Conversation.tsx src/renderer/components/ConversationPane.tsx tests/ipc.test.ts tests/preload-bridge.test.ts tests/ipc-bridge.test.ts tests/use-peer.test.tsx tests/peer-question.test.tsx
git commit -m "feat: 未決的同伴提問推到畫面,人可以代替回答或取消"
```

---

### Task 7: 提問方那側的介入與真的等待秒數

**Files:**
- Modify: `src/renderer/components/ConversationPane.tsx`
- Modify: `src/renderer/components/ToolCall.tsx`
- Modify: `src/renderer/components/PeerQuestion.tsx`
- Test: `tests/conversation-pane.test.tsx`(加)、`tests/tool-call.test.tsx`(加)

**Interfaces:**
- Consumes:Task 4 的 `useElapsedSeconds`、Task 6 的 `usePeer` 與 `PeerQuestionStatus`。
- Produces:`ToolCallProps.renderExtra` 的既有機制沿用,不新增 props。

行為:

- 回答方那側的等待秒數改成真的:用 `createdAt` 與現在的時間算,不是從畫面掛上去才開始算。
  對方可能是切回來才看到這一輪,從 0 開始數會騙人。
- 提問方那側:`ask_peer` 的 tool block 底下畫兩顆按鈕(代替回答、取消),
  沿用 `renderExtra` 這個既有機制,與批准卡掛在 tool block 底下同一條路。
- 對應的方式是 `questionId`:提問方的 `ask_peer` block 沒有 questionId,所以用
  「這個對話是某則未決問題的提問方」來找,一個對話同時只會有一則(規格 §4.1)。

- [ ] **Step 1: 寫失敗測試**

`tests/conversation-pane.test.tsx` 加:

```tsx
describe('提問方那側的介入', () => {
  it('ask_peer 執行中且自己是提問方時,底下畫兩顆按鈕', async () => {
    const rig = renderPane({
      conversationId: 'c1',
      view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name: ASK_PEER_TOOL, input: {}, status: 'running' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', text: '在嗎', createdAt: 1, queued: false }],
    })
    expect(await screen.findByRole('button', { name: '代替回答' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(rig.api.cancelPeer).toHaveBeenCalledWith({ questionId: 'q1' })
  })

  it('自己不是提問方時不畫按鈕', async () => {
    renderPane({
      conversationId: 'c1',
      view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name: ASK_PEER_TOOL, input: {}, status: 'running' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'cX', targetConversationId: 'c2', askerLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }],
    })
    expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  })

  it('回答方那一輪的等待秒數依 createdAt 算', () => {
    const now = 1_000_000
    renderPane({
      conversationId: 'c2',
      now,
      view: { turns: [{ role: 'user', blocks: [{ kind: 'peer-question', questionId: 'q1', fromLinkId: 'aaaa1111', provider: 'claude', text: '在嗎' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', text: '在嗎', createdAt: now - 42_000, queued: false }],
    })
    expect(screen.getByTestId('peer-status')).toHaveTextContent('等你回答，對方已等 42 秒')
  })
})
```

`renderPane` 要能接 `conversationId`、`view`、`peerPending` 與 `now` 四個入口;
既有 helper 沒有就在原 helper 上加。`rig.api` 是那個假的 `YesChefApi`。

`tests/tool-call.test.tsx` 加:

```tsx
it('renderExtra 的內容畫在 tool block 底下', () => {
  render(
    <ToolCall
      block={block({ name: ASK_PEER_TOOL })}
      historical={false}
      renderExtra={() => <button type="button">代替回答</button>}
    />
  )
  expect(screen.getByRole('button', { name: '代替回答' })).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/conversation-pane.test.tsx tests/tool-call.test.tsx`
Expected: FAIL,找不到那兩顆按鈕

- [ ] **Step 3: 真的秒數**

`src/renderer/components/PeerQuestion.tsx` 的狀態不變,改的是誰算這個數字。
`ConversationPane.tsx`:

```ts
  /** 每秒重算一次,讓等待秒數會動;沒有未決問題時不起計時器。 */
  const tick = useElapsedSeconds(peer.pending.length > 0)
  const waitedOf = useCallback(
    (createdAt: number): number => Math.max(0, Math.floor((Date.now() - createdAt) / 1000)),
    // tick 只是為了每秒重算,值本身用不到。
    [tick]
  )
```

`peerFor` 裡 `waitedSeconds: 0` 改成 `waitedSeconds: waitedOf(item.createdAt)`。

測試要能固定時間:`renderPane` 的 `now` 入口用 `vi.setSystemTime(now)` 實作,
不要在正式程式碼裡多開一個時鐘參數。

- [ ] **Step 4: 提問方那側的按鈕**

`ConversationPane.tsx`。既有的 `renderToolExtra` 現在畫的是批准卡,
在它裡面補一段:那個 block 是 `ask_peer` 而且自己是某則未決問題的提問方時,畫兩顆按鈕。

```tsx
  /** 一個對話同時只會有一則未決提問(規格 §4.1),所以找到第一則就是它。 */
  const myAsking = useMemo(
    () => peer.pending.find((p) => p.askerConversationId === conversationId),
    [peer.pending, conversationId]
  )
```

```tsx
      if (block.name === ASK_PEER_TOOL && block.status === 'running' && myAsking !== undefined) {
        return (
          <div className="peer-asking-actions">
            <PeerQuestion
              question={{ provider: 'claude', fromLinkId: myAsking.askerLinkId, questionId: myAsking.questionId, text: myAsking.text }}
              status={{ kind: 'waiting', waitedSeconds: waitedOf(myAsking.createdAt) }}
              onAnswer={(text) => { peer.answer(myAsking.questionId, text) }}
              onCancel={() => { peer.cancel(myAsking.questionId) }}
            />
          </div>
        )
      }
```

放在既有 `findAskForBlock` 那段之前或之後都可以,但兩者不會同時命中:
`ask_peer` 不需要批准(第一階段就加進允許清單了)。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/conversation-pane.test.tsx tests/tool-call.test.tsx`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ConversationPane.tsx src/renderer/components/ToolCall.tsx src/renderer/components/PeerQuestion.tsx tests/conversation-pane.test.tsx tests/tool-call.test.tsx
git commit -m "feat: 提問方那側也能代替回答或取消,等待秒數依提問時間算"
```

---

## 驗收

單元測試以外,這一階段要能用兩個真的對話跑完下面七項。操作方式沿用 RESULTS-14:
`npx electron . --remote-debugging-port=9336 --user-data-dir=<fixture>`,狀態檔事先擺好,
用 CDP 連上 renderer。動作前先讀 `getProjects()` 的 `busyTabIds` 確認對方真的在忙,
不要用「我覺得它應該還在跑」當依據。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | A 問 B,切到 B 看 | 提問自成一輪,角色是「同伴提問」不是「你」,標示是 `claude · <前 8 碼>` |
| 2 | 在 A 那邊看 `ask_peer` 那個 tool block | 狀態字是「等同伴回答,已等 n 秒」,n 每秒增加 |
| 3 | B 在背景要跑一個需要批准的工具 | 批准卡出現在 A 的畫面上,標示是「<專案名> · B」,點標示會切到 B |
| 4 | 那張卡放著不動 5 分鐘 | 5 分鐘才逾時,不是 30 秒 |
| 5 | 在 A 那邊按「代替回答」,寫一段字送出 | A 的 `ask_peer` 拿到那段字;信箱多一個 answer 檔,`actor` 是 `user`,`from` 是 B 的 linkId |
| 6 | 再問一題,在 B 那邊按「取消」 | A 的 `ask_peer` 以「使用者取消」結束;信箱多一個 cancel 檔,`actor` 是 `user` |
| 7 | 關掉 app 再開,切到 B 看歷史 | 那一輪仍然是「同伴提問」,沒有變回一大段「你」說的字 |

檢查信箱:

```bash
ls -1 <專案>/.yeschef/mail/
cat <專案>/.yeschef/mail/answer-*.json
```

## 自我檢查

**規格涵蓋**:P 規格 §6.2 的「自成一輪」在 Task 3、「等待秒數」在 Task 4 與 Task 7;
§6.5 的兩顆按鈕與 cancel 欄位表在 Task 5 與 Task 6,提問方那側在 Task 7。
D2 規格 §11 的六列:扣住拿掉在 Task 1、卡片位置與標示與跳轉在 Task 2、
逾時在 Task 1、待批准記號在 Task 1、跨專案在 Task 2(`foreign` 不分專案)。

P 規格 §6.2 還寫了「切回專案的重播、開歷史對話的檢視,要由宿主合併信箱裡的訊息」。
這一階段不做那個合併,理由寫在這裡:提問本身在逐字稿裡就是那則注入的 user 訊息,
Task 3 的解析在歷史那條路一樣認得出來(驗收第 7 項驗這件事);答案在提問方那側是
`ask_peer` 的工具結果,也在逐字稿裡。真正不在逐字稿裡的只有「這則提問後來被取消了」
這個事實,而它只影響已經結束的對話的回顧。要補的話是另一個 Task:主行程開一條
invoke 頻道讀信箱,renderer 在歷史檢視時把狀態補上去。留給第三階段與 codex 接線一起評估。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼或可以直接跑的指令。三處明講「沿用既有 helper,
不要另建一套」的地方(Task 2 的 `renderPane`、Task 6 的 `fakePeerService`、Task 7 的 `renderPane` 入口),
是因為那些 helper 的內部形狀要看現場,計畫不猜。

**型別一致**:`PeerInjection` 的四個欄位名(`provider`、`fromLinkId`、`questionId`、`text`)
在 Task 3 定義,Task 3 的 Block、Task 6 與 Task 7 傳給 `PeerQuestion` 的物件都用同一組。
`PeerPending`(main)與 `PeerPendingView`(shared)欄位完全相同,前者是服務的回傳型別,
後者是 IPC payload 的型別,ipc-bridge 直接把前者當後者送出去。
`PeerQuestionStatus` 只有 Task 3 一處定義,Task 6、7 沿用。
`useElapsedSeconds(active: boolean): number` 在 Task 4 定義,Task 7 用它當每秒重算的觸發。
