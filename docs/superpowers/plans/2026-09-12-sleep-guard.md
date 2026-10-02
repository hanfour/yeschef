# 按需擋主機睡眠 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 有任何對話在跑時擋住系統睡眠,全部閒置時放行(roadmap 第 4 項的後半)。

**Architecture:** `src/main/sleep-guard.ts` 是一個純模組,注入 Electron `powerSaveBlocker` 的三個函式,只做「有工作 → start、沒工作 → stop」的狀態機。`ipc-bridge` 每次推 projects view 時算出「有沒有任何對話在忙」,變了就通知。`index.ts` 接線。

**Tech Stack:** Electron `powerSaveBlocker`、TypeScript strict、vitest

**Spec:** `docs/specs/2026-09-07-yeschef-roadmap.md` §2.2 與 §4 第 4 項

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess`;不可用 `any` 或 `!`;不可就地修改;繁體中文註解說明為什麼。
- commit 訊息 `<type>: <描述>`,繁體中文,不加 trailer。測試不用 jest-dom;Stmts ≥ 93、Branch ≥ 86。
- `powerSaveBlocker.start` 的型別固定用 `'prevent-app-suspension'`(規格 §2.2:擋系統睡眠,不擋螢幕關閉)。
- 觸發訊號第一版只有「任何專案有任何對話 `isBusy()`」。手機 SSH 連線那個訊號等手機實測後再加(RESULTS-07 §7 記手機那半還沒驗)。
- 主行程 log 固定兩句:`[yeschef] 擋睡眠:有對話在執行` 與 `[yeschef] 放行睡眠:全部閒置`。
- 不新增 IPC,renderer 不動。

---

### Task 1: sleep-guard 與接線

**Files:**
- Create: `src/main/sleep-guard.ts`
- Modify: `src/main/ipc-bridge.ts`(`pushProjects` 附近,deps 加一個選填 callback)
- Modify: `src/main/index.ts`(接線與視窗關閉時 stop)
- Test: `tests/sleep-guard.test.ts`(新增)、`tests/ipc-bridge.test.ts`(加一條)

**Interfaces:**
- `createSleepGuard(deps: SleepGuardDeps): SleepGuard`,`SleepGuard = { setBusy(busy: boolean): void; dispose(): void; isBlocking(): boolean }`
- `SleepGuardDeps = { start(): number; stop(id: number): void; isStarted(id: number): boolean; log(line: string): void }`
- `IpcBridgeDeps.onAnyBusyChange?: (anyBusy: boolean) => void`:只在「有沒有任何對話在忙」這個布林值真的改變時呼叫,首次推送也算(從 undefined 變成 false 也要呼叫一次,讓接線端有初始值)。

- [ ] **Step 1: 寫失敗測試**

`tests/sleep-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSleepGuard } from '../src/main/sleep-guard.js'

function fake() {
  const calls: string[] = []
  const started = new Set<number>()
  let nextId = 1
  const deps = {
    start: () => { const id = nextId++; started.add(id); calls.push(`start:${String(id)}`); return id },
    stop: (id: number) => { started.delete(id); calls.push(`stop:${String(id)}`) },
    isStarted: (id: number) => started.has(id),
    log: (line: string) => { calls.push(`log:${line}`) },
  }
  return { deps, calls, started }
}

describe('sleep-guard', () => {
  it('有工作就 start 一次,重複說有工作不會再 start', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setBusy(true)
    guard.setBusy(true)
    expect(calls).toEqual(['start:1', 'log:[yeschef] 擋睡眠:有對話在執行'])
    expect(guard.isBlocking()).toBe(true)
  })

  it('沒工作就 stop,重複說沒工作不會再 stop', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setBusy(false)
    expect(calls).toEqual([])
    guard.setBusy(true)
    guard.setBusy(false)
    guard.setBusy(false)
    expect(calls).toEqual(['start:1', 'log:[yeschef] 擋睡眠:有對話在執行', 'stop:1', 'log:[yeschef] 放行睡眠:全部閒置'])
    expect(guard.isBlocking()).toBe(false)
  })

  it('系統把 blocker 撤掉之後(isStarted 變 false),下一次有工作會重新 start', () => {
    const { deps, calls, started } = fake()
    const guard = createSleepGuard(deps)
    guard.setBusy(true)
    started.clear()
    guard.setBusy(true)
    expect(calls.filter((c) => c.startsWith('start'))).toEqual(['start:1', 'start:2'])
  })

  it('dispose 會 stop 並且之後不再作用', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setBusy(true)
    guard.dispose()
    guard.setBusy(true)
    expect(calls.filter((c) => !c.startsWith('log'))).toEqual(['start:1', 'stop:1'])
  })
})
```

`tests/ipc-bridge.test.ts` 加一條,沿用檔案裡建 bridge 與假 core 的既有 helper:
兩個對話都閒置時建 bridge → `onAnyBusyChange` 收到 `[false]`;讓第一個對話 busy 並觸發 `onBusyChange` → 多收到 `true`;
第二個也 busy → 沒有新呼叫;第一個閒置 → 沒有新呼叫;第二個也閒置 → 多收到 `false`。
既有 helper 的形狀要看現場,測的是「只在布林值改變時呼叫」。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/sleep-guard.test.ts tests/ipc-bridge.test.ts`
Expected: FAIL,找不到 `sleep-guard` 模組

- [ ] **Step 3: sleep-guard**

```ts
export interface SleepGuardDeps {
  start(): number
  stop(id: number): void
  isStarted(id: number): boolean
  log(line: string): void
}

export interface SleepGuard {
  setBusy(busy: boolean): void
  dispose(): void
  isBlocking(): boolean
}

export const MSG_BLOCK = '[yeschef] 擋睡眠:有對話在執行'
export const MSG_RELEASE = '[yeschef] 放行睡眠:全部閒置'

/**
 * 有對話在跑就擋系統睡眠,全部閒置就放行(roadmap §2.2:主機睡著沒有任何方案能繼續運算,
 * 所以在需要的時候不讓它睡;閒置時放行,不耗電池)。
 * 每次都先問 isStarted:系統可能自己把 blocker 撤掉(例如使用者強制睡眠後醒來),
 * 那時 id 還在但已經沒作用,要重新 start。
 */
export function createSleepGuard(deps: SleepGuardDeps): SleepGuard {
  let id: number | undefined
  let disposed = false
  const blocking = (): boolean => id !== undefined && deps.isStarted(id)
  return {
    setBusy: (busy) => {
      if (disposed) return
      if (busy && !blocking()) {
        id = deps.start()
        deps.log(MSG_BLOCK)
      } else if (!busy && id !== undefined) {
        if (deps.isStarted(id)) deps.stop(id)
        id = undefined
        deps.log(MSG_RELEASE)
      }
    },
    dispose: () => {
      if (id !== undefined && deps.isStarted(id)) deps.stop(id)
      id = undefined
      disposed = true
    },
    isBlocking: blocking,
  }
}
```

注意第二條測試:`setBusy(false)` 在從來沒 start 過時不能 log。上面的寫法靠 `id !== undefined` 擋住。

- [ ] **Step 4: ipc-bridge**

`IpcBridgeDeps` 加 `readonly onAnyBusyChange?: (anyBusy: boolean) => void`。
`pushProjects` 算完 view 之後:

```ts
    const anyBusy = view.projects.some((p) => p.busyTabIds.length > 0)
    if (anyBusy !== lastAnyBusy) {
      lastAnyBusy = anyBusy
      deps.onAnyBusyChange?.(anyBusy)
    }
```

`let lastAnyBusy: boolean | undefined` 放在 bridge 的閉包裡,初始 `undefined` 讓第一次推送一定呼叫一次。
`view` 是 `pushProjects` 裡已經算出來要送給 renderer 的那個物件,不要另外再算一次。

- [ ] **Step 5: index.ts**

```ts
  const sleepGuard = createSleepGuard({
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => { powerSaveBlocker.stop(id) },
    isStarted: (id) => powerSaveBlocker.isStarted(id),
    log: (line) => { console.error(line) },
  })
```

`createIpcBridge` 的 deps 加 `onAnyBusyChange: (busy) => { sleepGuard.setBusy(busy) }`。
`win.on('closed', …)` 那個既有 handler 裡加 `sleepGuard.dispose()`(放在 `bridge.dispose()` 之後:對話收完才算全部閒置)。
`powerSaveBlocker` 從 `electron` import。`index.ts` 沒有單元測試(既有慣例),這一步只要 typecheck 與 build 過。

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck` → 0 errors;`npx vitest run` → PASS;`npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86;`npm run build` → 成功

- [ ] **Step 7: Commit**

```bash
git add src/main/sleep-guard.ts src/main/ipc-bridge.ts src/main/index.ts tests/sleep-guard.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: 有對話在執行時擋住系統睡眠,閒置放行"
```

## 驗收

主行程開 `--inspect=9229`,從 inspector 讀 `powerSaveBlocker.isStarted(<id>)`(id 從 log 或把 guard 掛到 global 讀)。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 開起來沒有對話在跑 | 沒有 blocker;log 沒有「擋睡眠」 |
| 2 | 讓一個對話跑 45 秒的 Bash | log 出現「擋睡眠」一次;`isStarted` 為 true |
| 3 | 期間再讓第二個對話跑 | log 沒有第二次「擋睡眠」 |
| 4 | 兩個都結束 | log 出現「放行睡眠」一次;`isStarted` 為 false;`pmset -g assertions` 裡 yeschef 的 `PreventUserIdleSystemSleep` 消失 |
