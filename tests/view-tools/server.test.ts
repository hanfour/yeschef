import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../src/shared/peer-tools.js'
import { PeerError } from '../../src/main/peer/errors.js'
import type { PeerTools } from '../../src/main/peer/service.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { WebContentsView } from 'electron'
import { z } from 'zod'
import { CdpError } from '../../src/main/cdp.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { HANDOFF_TIMEOUT_MS } from '../../src/main/view-tools/handoff.js'
import type { ToolOutput } from '../../src/main/view-tools/controller.js'
import { createViewToolServer, type ViewTools } from '../../src/main/view-tools/server.js'
import { createConversationViewServer, type ConversationViewServer } from '../../src/main/view-tools/conversation-server.js'
import { VIEW_TOOL_NAMES } from '../../src/shared/view-tools.js'
import { createFakeCdp, type FakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'

const shared = vi.hoisted(() => ({
  order: [] as string[],
  controller: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  watcher: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  settle: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  handoff: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  createWatcher: null as unknown as () => Promise<Record<string, ReturnType<typeof vi.fn>>>,
  settleFailure: null as unknown as Error | null,
  watchDeps: [] as unknown[],
  serverOptions: null as unknown as { name: string; version?: string; timeout?: number; tools?: { name: string; description: string; inputSchema: Record<string, z.ZodType>; _meta?: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<unknown> }[] },
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    createSdkMcpServer: (options: Parameters<typeof actual.createSdkMcpServer>[0]) => {
      shared.serverOptions = options as typeof shared.serverOptions
      return actual.createSdkMcpServer(options)
    },
  }
})
vi.mock('../../src/main/view-tools/watch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createWatcher: (deps: unknown) => { shared.watchDeps.push(deps); return shared.createWatcher() },
}))
vi.mock('../../src/main/view-tools/settle.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSettleTracker: () => {
    if (shared.settleFailure !== null) throw shared.settleFailure
    return shared.settle
  },
}))
vi.mock('../../src/main/view-tools/handoff.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createHandoff: () => shared.handoff,
}))
vi.mock('../../src/main/view-tools/controller.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createViewController: () => shared.controller,
}))

const OK_TEXT: ToolOutput = { kind: 'text', text: '好了' }
const PNG: ToolOutput = { kind: 'image', text: '可視範圍 800×600，網址 https://example.test/', dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }

/** 每個 controller 方法的最後一個參數都是 signal，統一記下來給 signal 相關的斷言用。 */
let signals: AbortSignal[]
let logError: Mock<(error: Error) => void>
let cdp: FakeCdp
let testClock: ReturnType<typeof manualClock>
let webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }
/** build() 替這個 session 建的那份對話 server。 */
let project: ConversationViewServer
/** busy() 通知的紀錄，build() 的 onBusyChange 會 push 進來。 */
let busyChanges: boolean[]

function resolving(output: ToolOutput) {
  return vi.fn((...args: unknown[]) => {
    signals.push(args[args.length - 1] as AbortSignal)
    return Promise.resolve(output)
  })
}

/** 永不 settle：讓呼叫停在 inflight 裡，才能測 abortPending 與 extra.signal。 */
function pendingForever() {
  return vi.fn((...args: unknown[]) => {
    signals.push(args[args.length - 1] as AbortSignal)
    return new Promise<ToolOutput>(() => {})
  })
}

beforeEach(() => {
  busyChanges = []
  signals = []
  shared.order = []
  shared.watchDeps = []
  shared.settleFailure = null
  testClock = manualClock()
  logError = vi.fn<(error: Error) => void>()
  cdp = createFakeCdp()
  webContents = {
    isDestroyed: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => '標題',
    on: vi.fn(),
    off: vi.fn(),
  }
  shared.controller = {
    navigate: resolving(OK_TEXT), snapshot: resolving(OK_TEXT), screenshot: resolving(PNG),
    click: resolving(OK_TEXT), type: resolving(OK_TEXT), press: resolving(OK_TEXT),
    evaluate: resolving(OK_TEXT), requestHandoff: resolving(OK_TEXT), login: resolving(OK_TEXT),
  }
  shared.watcher = { refs: vi.fn(), setRefs: vi.fn(), intervention: vi.fn(), takeIntervention: vi.fn(), runAsAgent: vi.fn(), dispose: vi.fn(() => { shared.order.push('watcher.dispose') }) }
  shared.createWatcher = () => Promise.resolve(shared.watcher)
  shared.settle = { inflight: vi.fn(), waitForQuiet: vi.fn(), waitForLoad: vi.fn(), dispose: vi.fn(() => { shared.order.push('settle.dispose') }) }
  shared.handoff = { pending: vi.fn(), begin: vi.fn(), done: vi.fn(), abortAll: vi.fn(() => { shared.order.push('handoff.abortAll') }) }
})

/** 建一個 session 的工具，並替它的對話建一份 MCP server；shared.serverOptions 之後就是這一份的內容。 */
async function build(peer?: PeerTools): Promise<ViewTools> {
  const tools = await createViewToolServer({
    view: { webContents } as unknown as WebContentsView,
    cdp,
    clock: testClock.clock,
    projectDir: () => '/專案',
    logError,
    credentials: async () => undefined,
    onBusyChange: (busy) => { busyChanges.push(busy) },
  })
  project = createConversationViewServer({ resolve: () => Promise.resolve(tools), logError, ...(peer === undefined ? {} : { peer }) })
  return tools
}

function toolDef(name: string) {
  const found = shared.serverOptions.tools?.find((t) => t.name === name)
  if (found === undefined) throw new Error(`找不到工具 ${name}`)
  return found
}

async function call(name: string, args: object, extra: unknown = { _meta: {} }) {
  return (await toolDef(name).handler(args as never, extra)) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
}

function ctrl(name: string): ReturnType<typeof vi.fn> {
  const fn = shared.controller[name]
  if (fn === undefined) throw new Error(`沒有 ${name}`)
  return fn
}

describe('工具定義', () => {
  it('每個專案的 server 名稱、版本與九個工具的名稱順序都照契約', async () => {
    await build()
    expect(shared.serverOptions.name).toBe('yeschef')
    expect(shared.serverOptions.version).toBe('0.1.0')
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
  })

  it('server 帶 11 分鐘的工具呼叫上限，不受 MCP_TOOL_TIMEOUT 影響', async () => {
    await build()
    expect(shared.serverOptions.timeout).toBe(HANDOFF_TIMEOUT_MS + 60_000)
    expect(shared.serverOptions.timeout).toBe(660_000)
  })

  it('九個工具都帶 alwaysLoad', async () => {
    await build()
    for (const def of shared.serverOptions.tools ?? []) {
      expect(def._meta, def.name).toEqual({ 'anthropic/alwaysLoad': true })
    }
  })

  it('每個工具都有非空的中文描述', async () => {
    await build()
    for (const def of shared.serverOptions.tools ?? []) {
      expect(def.description.length, def.name).toBeGreaterThan(0)
    }
  })

  it('zod shape 的欄位名稱與必填選填照契約', async () => {
    await build()
    expect(Object.keys(toolDef('view_navigate').inputSchema)).toEqual(['url'])
    expect(Object.keys(toolDef('view_snapshot').inputSchema)).toEqual(['scope'])
    expect(Object.keys(toolDef('view_screenshot').inputSchema)).toEqual([])
    expect(Object.keys(toolDef('view_click').inputSchema)).toEqual(['ref'])
    expect(Object.keys(toolDef('view_type').inputSchema)).toEqual(['ref', 'text', 'clear', 'submit'])
    expect(Object.keys(toolDef('view_press').inputSchema)).toEqual(['key'])
    expect(Object.keys(toolDef('view_eval').inputSchema)).toEqual(['expression'])
    expect(Object.keys(toolDef('request_handoff').inputSchema)).toEqual(['reason'])
  })

  it('view_type 的 clear／submit 是選填，view_snapshot 的 scope 只收兩個值', async () => {
    await build()
    const typeShape = z.object(toolDef('view_type').inputSchema)
    expect(typeShape.safeParse({ ref: 's1-e0', text: 'hi' }).success).toBe(true)
    expect(typeShape.safeParse({ ref: 's1-e0' }).success).toBe(false)
    const scopeShape = z.object(toolDef('view_snapshot').inputSchema)
    expect(scopeShape.safeParse({}).success).toBe(true)
    expect(scopeShape.safeParse({ scope: 'full' }).success).toBe(true)
    expect(scopeShape.safeParse({ scope: 'whole-page' }).success).toBe(false)
  })

  it('createWatcher 收到 cdp、webContents 與 logError', async () => {
    await build()
    expect(shared.watchDeps).toEqual([{ cdp, webContents, logError }])
  })
})

describe('參數傳遞與成功結果', () => {
  it('文字輸出包成單段 text 且不標 isError', async () => {
    await build()
    const result = await call('view_navigate', { url: 'https://a.test/' })
    expect(result).toEqual({ content: [{ type: 'text', text: '好了' }] })
    expect(result.isError).toBeUndefined()
    expect(ctrl('navigate').mock.calls[0]?.[0]).toBe('https://a.test/')
  })

  it('影像輸出包成 text 加 image 兩段', async () => {
    await build()
    const result = await call('view_screenshot', {})
    expect(result.content).toEqual([
      { type: 'text', text: '可視範圍 800×600，網址 https://example.test/' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(result.isError).toBeUndefined()
  })

  it('view_snapshot 省略 scope 時用 viewport，給 full 時用 full', async () => {
    await build()
    await call('view_snapshot', {})
    await call('view_snapshot', { scope: 'full' })
    expect(ctrl('snapshot').mock.calls[0]?.[0]).toBe('viewport')
    expect(ctrl('snapshot').mock.calls[1]?.[0]).toBe('full')
  })

  it('view_type 的 clear 與 submit 省略時是 false，給值時原樣傳下去', async () => {
    await build()
    await call('view_type', { ref: 's3-e1', text: 'abc' })
    await call('view_type', { ref: 's3-e2', text: 'x', clear: true, submit: true })
    expect(ctrl('type').mock.calls[0]?.slice(0, 4)).toEqual(['s3-e1', 'abc', false, false])
    expect(ctrl('type').mock.calls[1]?.slice(0, 4)).toEqual(['s3-e2', 'x', true, true])
  })

  it('click、press、eval 的參數各自傳到對應方法', async () => {
    await build()
    await call('view_click', { ref: 's2-e7' })
    await call('view_press', { key: 'Enter' })
    await call('view_eval', { expression: '1 + 1' })
    expect(ctrl('click').mock.calls[0]?.[0]).toBe('s2-e7')
    expect(ctrl('press').mock.calls[0]?.[0]).toBe('Enter')
    expect(ctrl('evaluate').mock.calls[0]?.[0]).toBe('1 + 1')
  })
})

describe('錯誤包裝', () => {
  it('ViewToolError 直接用它的訊息並標 isError，不記 logError', async () => {
    await build()
    ctrl('click').mockRejectedValueOnce(new ViewToolError(MSG.refFormat))
    const result = await call('view_click', { ref: '亂寫' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.refFormat }], isError: true })
    expect(logError).not.toHaveBeenCalled()
  })

  it('CdpError 轉成 cdpFailed 並帶 code，不記 logError', async () => {
    await build()
    ctrl('press').mockRejectedValueOnce(new CdpError('沒有這個方法', '-32601'))
    const result = await call('view_press', { key: 'Enter' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.cdpFailed('-32601', '沒有這個方法') }], isError: true })
    expect(logError).not.toHaveBeenCalled()
  })

  it('一般 Error 先 logError 再轉成 internal', async () => {
    await build()
    const boom = new Error('undefined 不是函式')
    ctrl('evaluate').mockRejectedValueOnce(boom)
    const result = await call('view_eval', { expression: 'x()' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.internal('undefined 不是函式') }], isError: true })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBe(boom)
  })

  it('丟出非 Error 的值也會 logError 並包成 internal', async () => {
    await build()
    ctrl('navigate').mockRejectedValueOnce('壞掉了')
    const result = await call('view_navigate', { url: 'https://a.test/' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.internal('壞掉了') }], isError: true })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('controller 同步丟例外時 handler 仍然 resolve', async () => {
    await build()
    ctrl('click').mockImplementationOnce(() => { throw new ViewToolError(MSG.viewGone) })
    await expect(call('view_click', { ref: 's1-e0' })).resolves.toEqual({
      content: [{ type: 'text', text: MSG.viewGone }], isError: true,
    })
  })
})

describe('signal、abortPending 與 dispose', () => {
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

  it('extra 沒有 signal 或不是 AbortSignal 時照樣可用，自己的中止仍然有效', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' }, undefined)
    void call('view_click', { ref: 's1-e1' }, { _meta: {}, signal: '不是 signal' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
  })

  it('abortPending 中止這個 session 全部進行中的呼叫', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    void call('view_click', { ref: 's1-e1' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)

    tools.abortPending('原因')
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
  })

  it('專案 dispose 以 sessionEnded 中止自己的呼叫', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    await Promise.resolve()
    await tools.dispose()
    expect(signals[0]?.aborted).toBe(true)
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)
  })

  it('dispose 之後回 sessionEnded，不呼叫 controller 也不登記 inflight', async () => {
    await build()
    project.dispose()

    const result = await call('view_click', { ref: 's1-e0' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.sessionEnded }], isError: true })
    expect(ctrl('click')).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
    expect(signals).toHaveLength(0)
  })
})

describe('request_handoff', () => {
  it('從 extra._meta 取到 toolUseId 並傳給 controller', async () => {
    await build()
    const result = await call('request_handoff', { reason: '請登入' }, { _meta: { 'claudecode/toolUseId': 'toolu_42' } })
    expect(ctrl('requestHandoff').mock.calls[0]?.slice(0, 2)).toEqual(['toolu_42', '請登入'])
    expect(result.isError).toBeUndefined()
  })

  it('取不到 toolUseId 時回 handoffNoId，不呼叫 controller 也不 logError', async () => {
    await build()
    const result = await call('request_handoff', { reason: '請登入' }, { _meta: { 'claudecode/toolUseId': '' } })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.handoffNoId }], isError: true })
    expect(ctrl('requestHandoff')).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('extra 完全不是物件時也只回 handoffNoId', async () => {
    await build()
    await expect(call('request_handoff', { reason: '請登入' }, 'nope')).resolves.toEqual({
      content: [{ type: 'text', text: MSG.handoffNoId }], isError: true,
    })
  })
})

describe('handoffDone 與 dispose', () => {
  it('handoffDone 轉給 handoff.done', async () => {
    const tools = await build()
    tools.handoffDone('toolu_9')
    expect(shared.handoff.done).toHaveBeenCalledWith('toolu_9')
  })

  it('dispose 先中止所有進行中的呼叫，再依序收 watcher、settle、handoff', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    void call('view_click', { ref: 's1-e1' })
    await Promise.resolve()
    signals[0]?.addEventListener('abort', () => { shared.order.push('abort') })
    signals[1]?.addEventListener('abort', () => { shared.order.push('abort') })
    await tools.dispose()
    expect(shared.order).toEqual(['abort', 'abort', 'watcher.dispose', 'settle.dispose', 'handoff.abortAll'])
    expect(signals.map((s) => (s.reason as Error).message)).toEqual([MSG.sessionEnded, MSG.sessionEnded])
  })
})

describe('建構逾時與部分清理', () => {
  it('createWatcher 永遠不 resolve 時，逾時後 reject 而不是卡住', async () => {
    let resolveWatcher: ((watcher: Record<string, ReturnType<typeof vi.fn>>) => void) | undefined
    shared.createWatcher = () => new Promise((resolve) => { resolveWatcher = resolve })
    const building = build()

    await Promise.resolve()
    testClock.advance(9_999)
    expect(resolveWatcher).toBeDefined()
    let settled = false
    void building.catch(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    testClock.advance(1)
    await expect(building).rejects.toThrow(MSG.internal('右窗格工具建立逾時'))
  })

  it('建構中途失敗時會解除已建立 watcher', async () => {
    const failure = new Error('settle 建立失敗')
    shared.settleFailure = failure

    await expect(build()).rejects.toBe(failure)
    expect(shared.watcher.dispose).toHaveBeenCalledTimes(1)
  })
})

const fakePeer = (over: Partial<PeerTools> = {}): PeerTools => ({
  askPeer: async () => '預設答案',
  answerPeer: async () => '已回答',
  ...over,
})

/** 從最近一次 createSdkMcpServer 的參數裡取一個工具的 handler。 */
const toolNamed = (name: string) => {
  const def = shared.serverOptions.tools?.find((t) => t.name === name)
  expect(def, name).toBeDefined()
  return def!
}

describe('同伴問答的兩個工具', () => {
  it('沒給 peer 就不掛,給了才多兩個,順序接在九個之後', async () => {
    await build()
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
    await build(fakePeer())
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES, 'ask_peer', 'answer_peer'])
  })

  it('兩個工具都帶 alwaysLoad 與非空中文描述', async () => {
    await build(fakePeer())
    for (const name of ['ask_peer', 'answer_peer']) {
      const def = toolNamed(name)
      expect(def._meta, name).toEqual({ 'anthropic/alwaysLoad': true })
      expect(def.description.length, name).toBeGreaterThan(0)
    }
  })

  it('ask_peer 把 to 傳下去', async () => {
    const seen: Array<[string, string | undefined]> = []
    await build(fakePeer({
      askPeer: async (question, to) => { seen.push([question, to]); return '好' },
    }))
    await toolNamed('ask_peer').handler({ question: '問題', to: 'bbbb' } as never, {})
    await toolNamed('ask_peer').handler({ question: '沒指定' } as never, {})
    expect(seen).toEqual([['問題', 'bbbb'], ['沒指定', undefined]])
  })

  it('answer_peer 回傳服務給的那句話', async () => {
    await build(fakePeer({ answerPeer: async (id) => `已回答 ${id}` }))
    const result = await toolNamed('answer_peer').handler({ id: 'q1', text: '答案' } as never, {})
    expect(result).toEqual({ content: [{ type: 'text', text: '已回答 q1' }] })
  })

  it('PeerError 變成 isError 的工具結果,訊息原樣送給模型', async () => {
    await build(fakePeer({
      askPeer: async () => { throw new PeerError('這個專案沒有別的同伴') },
    }))
    const result = await toolNamed('ask_peer').handler({ question: '有人嗎' } as never, {})
    expect(result).toEqual({ content: [{ type: 'text', text: '這個專案沒有別的同伴' }], isError: true })
  })

  it('工具名稱的完整形式與 shared 的常數一致', () => {
    expect(ASK_PEER_TOOL).toBe('mcp__yeschef__ask_peer')
    expect(ANSWER_PEER_TOOL).toBe('mcp__yeschef__answer_peer')
  })
})

describe('同伴工具的生命週期與例外', () => {
  it('等待回答不受 abortPending 或 dispose 中止', async () => {
    let answer!: (text: string) => void
    const waiting = new Promise<string>((resolve) => { answer = resolve })
    const tools = await build(fakePeer({ askPeer: () => waiting }))
    const result = toolNamed('ask_peer').handler({ question: '在嗎' } as never, {})
    tools.abortPending(MSG.sessionEnded)
    await tools.dispose()
    answer('仍然收到答案')
    await expect(result).resolves.toEqual({ content: [{ type: 'text', text: '仍然收到答案' }] })
  })

  it.each(['ask_peer', 'answer_peer'])('%s 的非 PeerError 沿用既有錯誤翻譯', async (name) => {
    for (const error of [new Error('失敗'), '失敗', new CdpError('失敗', '-1'), new ViewToolError('失敗')]) {
      logError.mockClear()
      const fail = async () => { throw error }
      await build(fakePeer({ askPeer: fail, answerPeer: fail }))
      const result = await toolNamed(name).handler({ question: '問題', id: 'q1', text: '答案' } as never, {})
      const text = error instanceof CdpError ? MSG.cdpFailed('-1', '失敗')
        : error instanceof ViewToolError ? '失敗' : MSG.internal('失敗')
      expect(result).toEqual({ content: [{ type: 'text', text }], isError: true })
      expect(logError).toHaveBeenCalledTimes(error instanceof CdpError || error instanceof ViewToolError ? 0 : 1)
    }
  })
})

describe('invoke(後端無關的入口)', () => {
  it('成功時回 ok 與 controller 的輸出,參數照樣傳下去', async () => {
    await build()
    const result = await project.invoke('view_click', { ref: 's2-e7' }, { callId: 'exec-1' })
    expect(result).toEqual({ ok: true, output: OK_TEXT })
    expect(ctrl('click').mock.calls[0]?.[0]).toBe('s2-e7')
  })

  it('影像輸出原樣回傳,由各自的殼決定怎麼包', async () => {
    await build()
    expect(await project.invoke('view_screenshot', {}, { callId: 'exec-2' })).toEqual({ ok: true, output: PNG })
  })

  it('dispose 之後回 sessionEnded', async () => {
    await build()
    project.dispose()
    expect(await project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-4' }))
      .toEqual({ ok: false, text: MSG.sessionEnded })
  })

  it('不認得的工具名回 unknownTool,不記 logError', async () => {
    await build()
    expect(await project.invoke('view_teleport', {}, { callId: 'exec-5' }))
      .toEqual({ ok: false, text: MSG.unknownTool('view_teleport') })
    expect(logError).not.toHaveBeenCalled()
  })

  it('參數型別不對回 badArgs,不呼叫 controller,也不記 logError', async () => {
    await build()
    expect(await project.invoke('view_click', { ref: 7 }, { callId: 'exec-6' }))
      .toEqual({ ok: false, text: MSG.badArgs('view_click', 'ref') })
    expect(ctrl('click')).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('選填參數省略時補預設值,與 Claude 那條路一樣', async () => {
    await build()
    await project.invoke('view_type', { ref: 's3-e1', text: 'abc' }, { callId: 'exec-7' })
    await project.invoke('view_snapshot', {}, { callId: 'exec-8' })
    expect(ctrl('type').mock.calls[0]?.slice(0, 4)).toEqual(['s3-e1', 'abc', false, false])
    expect(ctrl('snapshot').mock.calls[0]?.[0]).toBe('viewport')
  })

  it('request_handoff 拿 ctx.callId 當 toolUseId;callId 為 null 時回 handoffNoId', async () => {
    await build()
    await project.invoke('request_handoff', { reason: '請登入' }, { callId: 'exec-9' })
    expect(ctrl('requestHandoff').mock.calls[0]?.slice(0, 2)).toEqual(['exec-9', '請登入'])
    expect(await project.invoke('request_handoff', { reason: '請登入' }, { callId: null }))
      .toEqual({ ok: false, text: MSG.handoffNoId })
  })

  it('ViewToolError 直接回訊息,一般例外先 logError 再包成 internal', async () => {
    await build()
    ctrl('click').mockRejectedValueOnce(new ViewToolError(MSG.refFormat))
    expect(await project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-a' }))
      .toEqual({ ok: false, text: MSG.refFormat })
    const boom = new Error('壞了')
    ctrl('evaluate').mockRejectedValueOnce(boom)
    expect(await project.invoke('view_eval', { expression: 'x()' }, { callId: 'exec-b' }))
      .toEqual({ ok: false, text: MSG.internal('壞了') })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('abortPending 會中止 invoke 進行中的呼叫(它有登記 inflight)', async () => {
    const tools = await build()
    shared.controller['click'] = pendingForever()
    void project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-c' })
    await Promise.resolve()
    expect(signals.at(-1)?.aborted).toBe(false)
    tools.abortPending(MSG.sessionEnded)
    expect(signals.at(-1)?.aborted).toBe(true)
  })

  it('ctx.signal 與自己的中止合併,任一邊中止都會傳到 controller', async () => {
    await build()
    shared.controller['click'] = pendingForever()
    const outer = new AbortController()
    void project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-d', signal: outer.signal })
    await Promise.resolve()
    expect(signals.at(-1)?.aborted).toBe(false)
    outer.abort(new Error('外面喊停'))
    expect(signals.at(-1)?.aborted).toBe(true)
  })
})

describe('busy 通知', () => {
  it('第一筆呼叫開始時通知 true,最後一筆結束時通知 false,中間不重複通知', async () => {
    const tools = await build()
    let release: (v: ToolOutput) => void = () => {}
    ctrl('snapshot').mockImplementationOnce(() => new Promise<ToolOutput>((resolve) => { release = resolve }))
    const slow = tools.invoke('view_snapshot', {}, { callId: 'a' })
    await tools.invoke('view_press', { key: 'Tab' }, { callId: 'b' })
    expect(busyChanges).toEqual([true])
    expect(tools.busy()).toBe(true)
    release(OK_TEXT)
    await slow
    expect(busyChanges).toEqual([true, false])
    expect(tools.busy()).toBe(false)
  })
})
