import { describe, expect, it, vi } from 'vitest'
import {
  createGrokClient, killAllGrokProcesses, MSG, MSG_NO_GROK, withGrokAuthHint,
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
      // grok 1.0.40 真的回的形狀(controller 探測原文逐字貼):id 欄位叫 modelId,
      // reasoningEfforts 是物件陣列而且在 _meta 底下。
      availableModels: [
        {
          modelId: 'grok-4.7',
          name: 'Grok 4.7',
          description: 'Our most capable agentic coding model',
          _meta: {
            totalContextTokens: 500000,
            agentType: 'grok-build-plan',
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'xhigh', value: 'xhigh', label: 'Extra High', description: 'Most thorough', default: false },
              { id: 'high', value: 'high', label: 'High', description: 'Balanced', default: true },
              { id: 'low', value: 'low', label: 'Low', description: 'Fastest', default: false },
            ],
          },
        },
        { modelId: 'grok-4-fast', name: 'Grok 4 Fast', _meta: { reasoningEfforts: [{ id: 'low', default: true }] } },
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
      { id: 'grok-4.7', name: 'Grok 4.7', reasoningEfforts: ['xhigh', 'high', 'low'] },
      { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
    ])
  })

  it('killAllGrokProcesses 收掉還活著的子行程,結束過的不再碰', async () => {
    const first = setup()
    await first.boot('s-1')
    const second = setup()
    await second.boot('s-2')
    second.fake().exit(0)
    killAllGrokProcesses()
    expect(first.fake().killed).toContain('kill')
    // 已經結束的那一個不在名單裡,不會被再 kill 一次。
    expect(second.fake().killed).not.toContain('kill')
  })

  it('stop() 對已經死掉的子行程不等 killDelayMs', async () => {
    vi.useFakeTimers()
    try {
      const r = setup({ killDelayMs: 2000 })
      const client = await r.boot()
      r.fake().exit(1)
      let done = false
      const closing = client.close().then(() => { done = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
      await closing
    } finally {
      vi.useRealTimers()
    }
  })

  it('boot 逾時的訊息說的是 grok,不是 codex', async () => {
    const r = setup({ requestTimeoutMs: 5 })
    await r.waitFor('initialize')
    await expect(r.pending).rejects.toThrow(/grok/)
    await expect(r.pending).rejects.not.toThrow(/codex/)
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
    await expect(r.pending).rejects.toThrow(new Error(withGrokAuthHint('unauthorized: run grok login')))
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

  it('close 是自己發起的收尾,不算子行程意外結束,不呼叫 onExit', async () => {
    const r = setup()
    const client = await r.boot()
    const closing = client.close()
    await r.waitFor('session/close')
    r.fake().reply('session/close', {})
    await closing
    expect(r.exits).toEqual([])
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
