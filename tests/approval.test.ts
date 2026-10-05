import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  APPROVAL_TIMEOUT_MS,
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalRequest,
  type ApprovalRegistry,
} from '../src/main/approval.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

/** 建一份帶假 sendRequest 的註冊表，並回傳收到的請求清單供斷言。 */
function setup(opts?: { timeoutMs?: number | null; onSend?: (req: ApprovalRequest) => void }): {
  registry: ApprovalRegistry
  sent: ApprovalRequest[]
} {
  const sent: ApprovalRequest[] = []
  let counter = 0
  const registry = createApprovalRegistry({
    timeoutMs: opts?.timeoutMs,
    createRequestId: () => `req-${(counter += 1)}`,
    sendRequest: (req) => {
      sent.push(req)
      opts?.onSend?.(req)
    },
  })
  return { registry, sent }
}

/** ask 的最小形狀：三個必填欄位（裁決 28 之後 `toolUseId` 也是必填）。 */
const ask = (over: Partial<ApprovalAsk> & { toolName: string }): ApprovalAsk => ({
  toolUseId: 'toolu_1',
  input: {},
  ...over,
})

describe('createApprovalRegistry', () => {
  it('預設逾時是 5 分鐘', () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(300_000)
  })

  it('送出的請求帶正確的 requestId、toolUseId、toolName、input', async () => {
    const { registry, sent } = setup()
    const promise = registry.request(
      ask({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_ls' })
    )
    expect(sent).toEqual([
      { requestId: 'req-1', toolUseId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' } },
    ])
    registry.reply('req-1', 'allow')
    await promise
  })

  it('preflight 拒絕在送卡與建立 pending 前結束請求', async () => {
    const sent: ApprovalRequest[] = []
    const decision = vi.fn()
    const registry = createApprovalRegistry({
      sendRequest: request => sent.push(request),
      preflight: () => ({ decision: 'deny', source: 'system', reason: 'blocked' }),
      onDecision: decision,
    })
    await expect(registry.request(ask({ toolName: 'Bash' }))).resolves.toEqual({
      decision: 'deny', source: 'system', reason: 'blocked',
    })
    expect(sent).toEqual([])
    expect(registry.pendingCount()).toBe(0)
    expect(decision).toHaveBeenCalledOnce()
  })

  it('結局 1：renderer 回 allow', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Read', input: { path: 'a.ts' } }))
    expect(registry.reply('req-1', 'allow')).toBe(true)
    const outcome = await promise
    expect(outcome).toEqual({ decision: 'allow' })
  })

  it('結局 2：renderer 回 deny', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'rm -rf /' } }))
    expect(registry.reply('req-1', 'deny')).toBe(true)
    const outcome = await promise
    expect(outcome.decision).toBe('deny')
  })

  it('結局 3：逾時，deny 且 reason 留下可辨識的記錄（規格 §8）', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'sleep 999' } }))
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)
    const outcome = await promise
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toBe('批准請求逾時（300000ms 內未收到回覆）')
    expect(outcome.timedOut).toBe(true)
  })

  it('timeoutMs 為 null 時不設計時器,等待 denyAll 收尾', async () => {
    const { registry } = setup({ timeoutMs: null })
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'gh pr merge 137' } }))
    const pending = await Promise.race([promise, Promise.resolve('pending')])

    expect(pending).toBe('pending')
    expect(registry.pendingCount()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    registry.denyAll('視窗已關閉')
    await expect(promise).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
    expect(registry.pendingCount()).toBe(0)
  })

  it('結局 4：sendRequest 丟錯（視窗已關閉／renderer 未就緒）立即 deny，不留計時器', async () => {
    const { registry } = setup({
      timeoutMs: 30_000, // 刻意設大：若沒有立即 deny，測試會真的卡住
      onSend: () => {
        throw new Error('webContents 已銷毀')
      },
    })
    const promise = registry.request(ask({ toolName: 'Write', input: { path: 'x.ts' } }))
    // 同步斷言：Promise executor 是同步執行的，settle() 在 request() 回傳前就跑完，
    // 不必等任何一輪 microtask/timer 就能看到表已經清空。
    expect(registry.pendingCount()).toBe(0)
    const outcome = await promise
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toMatch(/送不出去|webContents 已銷毀/)
  })

  it('多個待決請求時互不干擾', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Read', input: { path: 'a.ts' } }))
    const p2 = registry.request(ask({ toolName: 'Read', input: { path: 'b.ts' } }))
    expect(registry.pendingCount()).toBe(2)

    const SENTINEL = Symbol('not-yet')
    registry.reply('req-1', 'allow')
    // req-2 還沒被回覆：跟一個立刻 resolve 的 sentinel 賽跑，證明它真的還掛著
    const raced = await Promise.race([p2, Promise.resolve(SENTINEL)])
    expect(raced).toBe(SENTINEL)
    expect(registry.pendingCount()).toBe(1)

    expect((await p1).decision).toBe('allow')
    registry.reply('req-2', 'deny')
    expect((await p2).decision).toBe('deny')
    expect(registry.pendingCount()).toBe(0)
  })

  it('回覆一個不存在的 requestId：回傳 false，不影響其他待決請求', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'ls' } }))
    expect(registry.reply('req-不存在', 'allow')).toBe(false)
    expect(registry.pendingCount()).toBe(1)
    registry.reply('req-1', 'allow')
    expect((await promise).decision).toBe('allow')
  })

  it('同一個 requestId 回覆兩次：第二次視為找不到（擋住「忘記清理」的實作）', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'ls' } }))
    expect(registry.reply('req-1', 'allow')).toBe(true)
    expect(registry.reply('req-1', 'deny')).toBe(false)
    expect((await promise).decision).toBe('allow') // 第二次回覆沒有蓋掉第一次的結果
  })

  it('denyAll 把所有待決請求立即以指定 reason 結束', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Bash', input: { command: 'a' } }))
    const p2 = registry.request(ask({ toolName: 'Bash', input: { command: 'b' } }))
    expect(registry.pendingCount()).toBe(2)

    registry.denyAll('切換 session')

    expect(registry.pendingCount()).toBe(0)
    expect(await p1).toEqual({ decision: 'deny', reason: '切換 session' })
    expect(await p2).toEqual({ decision: 'deny', reason: '切換 session' })
  })

  it('denyAll 在沒有待決請求時是無害的 no-op', () => {
    const { registry } = setup()
    expect(() => registry.denyAll('視窗已關閉')).not.toThrow()
    expect(registry.pendingCount()).toBe(0)
  })

  it('請求逾時後，計時器不會再次觸發（不留 dangling timer）', async () => {
    vi.useFakeTimers()
    try {
      const { registry } = setup({ timeoutMs: 100 })
      const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'x' } }))
      await vi.advanceTimersByTimeAsync(100)
      expect((await promise).decision).toBe('deny')
      expect(registry.pendingCount()).toBe(0)
      // 再推進時間不該有任何效果（沒有殘留的計時器可觸發）
      await vi.advanceTimersByTimeAsync(10_000)
      expect(registry.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('title／displayName 原封不動送到 sendRequest，且帶 requestId（裁決 11／16）', async () => {
    const { registry, sent } = setup()
    const promise = registry.request({
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
      title: '要執行 ls 嗎？',
      displayName: 'ls',
    })
    expect(sent).toEqual([
      {
        requestId: 'req-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'ls' },
        title: '要執行 ls 嗎？',
        displayName: 'ls',
      },
    ])
    registry.reply('req-1', 'allow')
    await promise
  })

  it('toolUseId 原封不動送到 sendRequest，兩筆請求各自帶自己的（裁決 28）', async () => {
    const { registry, sent } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Bash', toolUseId: 'toolu_a' }))
    const p2 = registry.request(ask({ toolName: 'Read', toolUseId: 'toolu_b' }))
    expect(sent.map((r) => r.toolUseId)).toEqual(['toolu_a', 'toolu_b'])
    registry.reply('req-1', 'allow')
    registry.reply('req-2', 'allow')
    await Promise.all([p1, p2])
  })
})

describe('onSettled:registry 每一種了結都通知一次', () => {
  function rigWithSettled(opts?: { timeoutMs?: number; throwOnSend?: boolean }) {
    const settled: string[] = []
    let counter = 0
    const registry = createApprovalRegistry({
      timeoutMs: opts?.timeoutMs,
      createRequestId: () => `req-${(counter += 1)}`,
      sendRequest: () => {
        if (opts?.throwOnSend) throw new Error('視窗已關')
      },
      onSettled: (requestId) => settled.push(requestId),
    })
    return { registry, settled }
  }
  const ask = { toolUseId: 't', toolName: 'Bash', input: {} }

  it('reply 了結 → 通知該 requestId', async () => {
    const { registry, settled } = rigWithSettled()
    const p = registry.request(ask)
    registry.reply('req-1', 'allow')
    await p
    expect(settled).toEqual(['req-1'])
  })

  it('逾時了結 → 通知', async () => {
    const { registry, settled } = rigWithSettled({ timeoutMs: 5 })
    const promise = registry.request(ask)
    await vi.advanceTimersByTimeAsync(5)
    await promise
    expect(settled).toEqual(['req-1'])
  })

  it('denyAll 了結 → 每一筆各通知一次', async () => {
    const { registry, settled } = rigWithSettled()
    const a = registry.request(ask)
    const b = registry.request(ask)
    registry.denyAll('關窗')
    await Promise.all([a, b])
    expect(settled.sort()).toEqual(['req-1', 'req-2'])
  })

  it('sendRequest 丟例外而立刻 deny → 也通知', async () => {
    const { registry, settled } = rigWithSettled({ throwOnSend: true })
    await registry.request(ask)
    expect(settled).toEqual(['req-1'])
  })

  it('同一筆 reply 兩次只通知一次', async () => {
    const { registry, settled } = rigWithSettled()
    const p = registry.request(ask)
    registry.reply('req-1', 'allow')
    registry.reply('req-1', 'deny')
    await p
    expect(settled).toEqual(['req-1'])
  })
})
