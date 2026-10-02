### Task 5: session 狀態機

規格 §7 的三個狀態與轉移，寫成純函式。副作用由呼叫端執行，狀態機只**描述**該做什麼。

這個設計的理由：切換 session 的收尾有三個步驟且順序固定（規格 §3.2），如果狀態機直接執行副作用，那個順序就只能靠整合測試驗證，而整合測試在 Electron 裡跑不動。把 effects 做成資料之後，順序變成可以用單元測試斷言的東西。

**Files:**
- Create: `src/shared/session-state.ts`（只有 `SessionState` 型別，裁決 14：renderer 與 main 都要用，放 shared）
- Create: `src/main/session-machine.ts`
- Create: `tests/session-machine.test.ts`
- Modify: `vitest.config.ts`（`coverage.include` 加一行 `'src/main/session-machine.ts'`）

**Interfaces:**
- Consumes: `ApprovalRegistry.denyAll(reason)` 的存在（Task 6），但只在 effect 裡描述，不直接呼叫
- Produces:
  - `type SessionState = { kind: 'idle' } | { kind: 'live'; sessionId?: string } | { kind: 'viewing'; sessionId: string }`
  - `type Action = { kind: 'start-new' } | { kind: 'open-history'; sessionId: string } | { kind: 'user-input'; text: string } | { kind: 'session-ended' } | { kind: 'window-closed' }`
  - `type Effect = { kind: 'deny-all-approvals'; reason: string } | { kind: 'interrupt-query' } | { kind: 'teardown-query' } | { kind: 'start-query'; resumeSessionId?: string; initialInput?: string } | { kind: 'load-history'; sessionId: string }`
  - `function transition(state: SessionState, action: Action): { readonly state: SessionState; readonly effects: readonly Effect[] }`

下游用法（裁決 6、14）：Task 8 的 `ipc-bridge.ts` 持有 `SessionState`，收到 renderer 的意圖（`intentStartNew`／`intentOpenHistory`／`userInput`）時呼叫 `transition`，然後**照 effects 陣列的順序**逐一執行，再把新狀態從 `session:state` 推回 renderer。`deny-all-approvals` 對應 `registry.denyAll(reason)`，`start-query` 對應 agent-host，`load-history` 對應 Task 11 的 `SessionStore.loadHistory`。renderer 只讀 `SessionState`，不呼叫 `transition`。

- [ ] **Step 1: 寫失敗的測試**

`tests/session-machine.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { transition, type Effect } from '../src/main/session-machine.js'
import type { SessionState } from '../src/shared/session-state.js'

const kinds = (effects: readonly Effect[]): string[] => effects.map((e) => e.kind)

describe('transition：從 idle 出發', () => {
  const idle: SessionState = { kind: 'idle' }

  it('start-new 進入 live 並要求開一個新 query', () => {
    const r = transition(idle, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({ kind: 'start-query' })
  })

  it('open-history 進入 viewing 並要求載入歷史', () => {
    const r = transition(idle, { kind: 'open-history', sessionId: 's-1' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('user-input 在 idle 是不合法轉移，狀態不變且無 effect', () => {
    const r = transition(idle, { kind: 'user-input', text: '你好' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })

  it('session-ended 在 idle 是無害的 no-op', () => {
    const r = transition(idle, { kind: 'session-ended' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe('transition：從 live 出發', () => {
  const live: SessionState = { kind: 'live', sessionId: 's-live' }

  it('session-ended 回到 idle，不需要收尾（query 自己結束了）', () => {
    const r = transition(live, { kind: 'session-ended' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual([])
  })

  it('window-closed 走完整的三步收尾', () => {
    const r = transition(live, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
  })

  it('open-history 先收尾再載入歷史，順序不可對調', () => {
    const r = transition(live, { kind: 'open-history', sessionId: 's-2' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-2' })
    expect(kinds(r.effects)).toEqual([
      'deny-all-approvals',
      'interrupt-query',
      'teardown-query',
      'load-history',
    ])
  })

  it('user-input 在 live 不改變狀態，也不產生 effect（輸入直接送進既有 query）', () => {
    const r = transition(live, { kind: 'user-input', text: '繼續' })
    expect(r.state).toEqual(live)
    expect(r.effects).toEqual([])
  })
})

describe('transition：從 viewing 出發', () => {
  const viewing: SessionState = { kind: 'viewing', sessionId: 's-old' }

  it('user-input 接續該 session，帶上 resume 與第一則輸入', () => {
    const r = transition(viewing, { kind: 'user-input', text: '接著問' })
    expect(r.state).toEqual({ kind: 'live', sessionId: 's-old' })
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({
      kind: 'start-query',
      resumeSessionId: 's-old',
      initialInput: '接著問',
    })
  })

  it('切到另一條歷史對話不需要收尾（viewing 沒有活躍 query）', () => {
    const r = transition(viewing, { kind: 'open-history', sessionId: 's-new' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-new' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('start-new 從 viewing 開新對話', () => {
    const r = transition(viewing, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
  })

  it('window-closed 只回 idle，不需要 query 相關的收尾', () => {
    const r = transition(viewing, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects).toEqual([])
  })
})

describe('收尾順序（規格 §3.2）', () => {
  it('deny-all-approvals 必須早於 interrupt-query，interrupt-query 必須早於 teardown-query', () => {
    const r = transition({ kind: 'live', sessionId: 'x' }, { kind: 'window-closed' })
    const k = kinds(r.effects)
    expect(k.indexOf('deny-all-approvals')).toBeLessThan(k.indexOf('interrupt-query'))
    expect(k.indexOf('interrupt-query')).toBeLessThan(k.indexOf('teardown-query'))
  })

  it('deny-all-approvals 帶著可讀的理由，會顯示在對話裡', () => {
    const a = transition({ kind: 'live' }, { kind: 'window-closed' }).effects[0]
    const b = transition({ kind: 'live' }, { kind: 'open-history', sessionId: 's' }).effects[0]
    expect(a).toEqual({ kind: 'deny-all-approvals', reason: '視窗已關閉' })
    expect(b).toEqual({ kind: 'deny-all-approvals', reason: '切換 session' })
  })
})

describe('不可變性', () => {
  it('不修改傳入的 state', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const snapshot = JSON.stringify(state)
    transition(state, { kind: 'window-closed' })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('回傳的 state 是新物件，不是傳入的那一個', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const r = transition(state, { kind: 'user-input', text: 'x' })
    // user-input 在 live 不改狀態，但仍須回傳新物件而非同一個參考
    expect(r.state).not.toBe(state)
    expect(r.state).toEqual(state)
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/session-machine.test.ts`
Expected: FAIL，無法解析 `../src/main/session-machine.js`

- [ ] **Step 3: 寫最小實作**

`src/shared/session-state.ts`（裁決 14。純型別檔，renderer 的 Recents 與 main 的狀態機共用；shared 不得 import main）：

```typescript
/** session 生命週期的三個狀態（規格 §7）。物件而非字串：viewing 要帶正在看哪一場。 */
export type SessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'live'; readonly sessionId?: string }
  | { readonly kind: 'viewing'; readonly sessionId: string }
```

`src/main/session-machine.ts`：

```typescript
/**
 * session 的狀態機。純函式，不執行副作用。
 *
 * effects 是「該做什麼」的描述，由呼叫端照陣列順序執行。這樣設計是因為
 * 規格 §3.2 規定切換 session 的收尾有三步且順序固定，而順序如果藏在
 * 命令式的程式碼裡，就只能靠跑得起 Electron 的整合測試來驗證。
 */

import type { SessionState } from '../shared/session-state.js'
export type { SessionState }

export type Action =
  | { readonly kind: 'start-new' }
  | { readonly kind: 'open-history'; readonly sessionId: string }
  | { readonly kind: 'user-input'; readonly text: string }
  | { readonly kind: 'session-ended' }
  | { readonly kind: 'window-closed' }

export type Effect =
  | { readonly kind: 'deny-all-approvals'; readonly reason: string }
  | { readonly kind: 'interrupt-query' }
  | { readonly kind: 'teardown-query' }
  | { readonly kind: 'start-query'; readonly resumeSessionId?: string; readonly initialInput?: string }
  | { readonly kind: 'load-history'; readonly sessionId: string }

export interface TransitionResult {
  readonly state: SessionState
  readonly effects: readonly Effect[]
}

/**
 * 收掉一個活躍 query 的三步驟，順序固定（規格 §3.2）。
 *
 * 先 deny 待決的批准：那些 promise 掛在 SDK 的 canUseTool 上，不結束就會讓
 * interrupt 卡住。再 interrupt 中止進行中的工具。最後才收掉 query。
 */
function teardownLive(reason: string): readonly Effect[] {
  return [
    { kind: 'deny-all-approvals', reason },
    { kind: 'interrupt-query' },
    { kind: 'teardown-query' },
  ]
}

export function transition(state: SessionState, action: Action): TransitionResult {
  switch (state.kind) {
    case 'idle':
      switch (action.kind) {
        case 'start-new':
          return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [{ kind: 'load-history', sessionId: action.sessionId }],
          }
        default:
          // user-input 與 session-ended 在 idle 沒有意義。不拋錯，回原狀態的複本。
          return { state: { kind: 'idle' }, effects: [] }
      }

    case 'live':
      switch (action.kind) {
        case 'session-ended':
          // query 自己結束了，不需要收尾
          return { state: { kind: 'idle' }, effects: [] }
        case 'window-closed':
          return { state: { kind: 'idle' }, effects: teardownLive('視窗已關閉') }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [
              ...teardownLive('切換 session'),
              { kind: 'load-history', sessionId: action.sessionId },
            ],
          }
        case 'start-new':
          return {
            state: { kind: 'live' },
            effects: [...teardownLive('切換 session'), { kind: 'start-query' }],
          }
        case 'user-input':
          // 已經有活躍 query，輸入直接送進去，不經狀態機
          return { state: { ...state }, effects: [] }
      }

    case 'viewing':
      switch (action.kind) {
        case 'user-input':
          return {
            state: { kind: 'live', sessionId: state.sessionId },
            effects: [
              { kind: 'start-query', resumeSessionId: state.sessionId, initialInput: action.text },
            ],
          }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [{ kind: 'load-history', sessionId: action.sessionId }],
          }
        case 'start-new':
          return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
        case 'window-closed':
        case 'session-ended':
          // viewing 沒有活躍 query，不需要收尾
          return { state: { kind: 'idle' }, effects: [] }
      }
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/session-machine.test.ts`
Expected: PASS，17 個測試

Run: `npm run typecheck`
Expected: 乾淨。`switch` 的窮舉性由 TypeScript 檢查，漏掉任何一個 action 會編譯失敗。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

三個突變各跑一次，每個都必須讓測試變紅：

| # | 突變 | 預期紅的測試 |
|---|---|---|
| 1 | `teardownLive` 的三個 effect 順序對調成 `[teardown-query, interrupt-query, deny-all-approvals]` | 「收尾順序」的兩條，以及 live 的 `window-closed` 與 `open-history` |
| 2 | `idle` 的 `default` 分支改成回 `{ state, effects: [{ kind: 'start-query' }] }`（把不合法轉移當成合法） | 「user-input 在 idle 是不合法轉移」 |
| 3 | `viewing` 的 `user-input` 拿掉 `resumeSessionId`（只傳 `initialInput`） | 「user-input 接續該 session，帶上 resume 與第一則輸入」 |

**突變 1 最重要**：它是這個 task 存在的理由。如果順序錯了而測試不紅，那把 effects 做成資料就沒有意義了，不如直接寫命令式程式碼。

**突變 3 是「看起來還會過」的那種**：狀態轉移完全正確、`start-query` 也發出去了，只是少了一個欄位。後果是使用者以為在接續舊對話，實際上開了一條新的，而 Insights 的歸屬也會跟著錯。

三次的紅燈輸出與還原後的綠燈都貼進報告。

- [ ] **Step 6: 加 coverage 條目，執行完整測試套件**

`vitest.config.ts` 的 `coverage.include` 加一行，其餘既有條目不動（裁決 19：每個 task 只增刪
自己的檔案，不重寫整份清單）。`src/shared/session-state.ts` 只有型別，被 Task 1 的
`'src/shared/**/*.ts'` 涵蓋但沒有可執行的行，不需另列。

```diff
   coverage: {
     include: [
       // ...既有條目不動...
+      'src/main/session-machine.ts',
     ],
   },
```

Run: `npm test`
Expected: PASS。把總數記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/shared/session-state.ts src/main/session-machine.ts tests/session-machine.test.ts vitest.config.ts
git commit -m "feat: session 狀態機，收尾順序以 effects 陣列表達並可測"
```
