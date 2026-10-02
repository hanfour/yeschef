import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHEF_TOOL_NAMES, createChefTools } from '../src/main/chef/tools.js'
import { CHEF_INTERNAL_TOOL_NAMES, isChefInternalTool } from '../src/shared/chef.js'
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
function fakeChef(role: 'chef' | 'worker') {
  const reports: unknown[] = []
  const service = {
    runnable: () => true,
    worker: () => ({ role, model: 'grok-4-7', taskId: 'task-1' }),
    delegate: () => Promise.resolve({ ok: true }),
    progress: () => Promise.resolve({ workers: [{ workerId: 'worker-2', evidence: 'tool result' }], groupMessages: [{ kind: 'text', text: '最近訊息' }] }),
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
  const server = await startViewToolHttpServer(() => view, logError)
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
  it('主廚工具呼叫端共用同一份名稱,並同時辨認 MCP 前綴與 Codex 裸名', () => {
    expect(CHEF_TOOL_NAMES).toBe(CHEF_INTERNAL_TOOL_NAMES)
    for (const name of CHEF_INTERNAL_TOOL_NAMES) {
      expect(isChefInternalTool(name)).toBe(true)
      expect(isChefInternalTool(`mcp__chef__${name}`)).toBe(true)
    }
    expect(isChefInternalTool('ToolSearch')).toBe(false)
    expect(isChefInternalTool('say_to_group_extra')).toBe(false)
  })

  it('worker 仍只拿 task_progress 與 say_to_group', () => {
    const worker = fakeChef('worker')
    expect(createChefTools(worker.service, 'w-1').names).toEqual(['task_progress', 'say_to_group'])
  })

  it('不是 worker 的對話:tools/list 沒有主廚的四個工具', async () => {
    const rig = await start()
    const names = await rig.names()
    expect(names).toContain('view_snapshot')
    for (const name of CHEF_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('chef 的 worker 對話:四個工具都在', async () => {
    const chef = fakeChef('chef')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const names = await rig.names()
    for (const name of CHEF_TOOL_NAMES) expect(names).toContain(name)
    expect(names).toContain('view_snapshot')
  })

  it('role 是 worker 時只掛 task_progress 與 say_to_group', async () => {
    const chef = fakeChef('worker')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const names = await rig.names()
    expect(names).toContain('task_progress')
    expect(names).toContain('say_to_group')
    expect(names).not.toContain('report_result')
    expect(names).not.toContain('delegate_task')
  })

  it('report_result 的呼叫真的進到 Chef 的處理函式,workerId 是這個對話', async () => {
    const chef = fakeChef('chef')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const called = await rig.invoke('report_result', REPORT)
    expect(called.status).toBe(200)
    expect(chef.reports).toEqual([['w-1', REPORT]])
    expect(called.body).toContain('accepted')
  })

  it('task_progress 回傳可解析且包含工作者與群組訊息的物件', async () => {
    const chef = fakeChef('chef')
    const outcome = await createChefTools(chef.service, 'w-1').call('task_progress', {})
    expect(outcome.ok).toBe(true)
    const progress = JSON.parse(outcome.text) as { workers: unknown[]; groupMessages: unknown[] }
    expect(progress).toEqual({
      workers: [{ workerId: 'worker-2', evidence: 'tool result' }],
      groupMessages: [{ kind: 'text', text: '最近訊息' }],
    })
  })

  it('主廚工具失敗時以文字回去,不是協定層錯誤', async () => {
    const chef = fakeChef('chef')
    const tools = createChefTools({ ...chef.service, runnable: () => false } as unknown as ChefService, 'w-1')
    const rig = await start(tools)
    const called = await rig.invoke('report_result', REPORT)
    expect(called.status).toBe(200)
    expect(called.body).toContain('這個工作者已停止或不是目前執行者')
  })
})

describe('主廚與工作者工具清單', () => {
  it('主廚拿得到四個工具,worker 只拿得到 task_progress 與 say_to_group', () => {
    const chief = createChefTools(fakeChef('chef').service, 'w1')
    expect([...chief.names]).toEqual(['delegate_task', 'task_progress', 'report_result', 'say_to_group'])
    expect(chief.sdkTools.map((tool) => tool.name)).toEqual(['delegate_task', 'task_progress', 'report_result', 'say_to_group'])
    const worker = createChefTools(fakeChef('worker').service, 'w2')
    expect([...worker.names]).toEqual(['task_progress', 'say_to_group'])
    expect(worker.sdkTools.map((tool) => tool.name)).toEqual(['task_progress', 'say_to_group'])
    expect(worker.names).not.toContain('delegate_task')
    expect(worker.specs.map((spec) => spec.name)).toEqual(['task_progress', 'say_to_group'])
  })

  it('task_progress 回傳的是 async 解開後的結果,不是 Promise', async () => {
    const tools = createChefTools(fakeChef('worker').service, 'w5')
    const outcome = await tools.call('task_progress', {})
    expect(outcome.ok).toBe(true)
    expect(outcome.text).not.toContain('Promise')
    expect(JSON.parse(outcome.text)).toHaveProperty('groupMessages')
    expect(createChefTools(fakeChef('worker').service, 'w5').specs.find((spec) => spec.name === 'task_progress')?.description)
      .toContain('不要另開單位代辦或重做')
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
    const spec = tools.specs.find((item) => item.name === 'say_to_group')
    expect(spec?.description).toContain('不用在逐步進度上')
  })
})
