import { describe, it, expect, vi, afterEach } from 'vitest'
import { realpath, mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPermissionService, type ShowSaveDialog } from '../src/main/permissions/service.js'
import { collectEvidence } from '../src/main/permissions/evidence.js'
import { createApprovalRegistry, type ApprovalRequest } from '../src/main/approval.js'
import { emptyPolicy } from '../src/shared/permissions.js'
import type { Reviewer, ReviewResult } from '../src/main/permissions/reviewer.js'
const roots: string[] = []
const services: Awaited<ReturnType<typeof createPermissionService>>[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.useRealTimers() })
async function rig(
  reviewer: Reviewer = async input => ({ requestHash: input.requestHash, verdict: 'allow', reason: '符合目的' }),
  showSaveDialog?: ShowSaveDialog,
  managedServices: () => readonly { pid: number; pgid: number; processName: string; port: number }[] = () => [],
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'yeschef-permission-'))); roots.push(root)
  const cwd = join(root, 'project'); await mkdir(cwd)
  const dir = join(root, 'settings')
  const service = await createPermissionService(dir, reviewer, id => id === 'p', () => {}, showSaveDialog, managedServices)
  services.push(service)
  const sent: ApprovalRequest[] = []
  const registry = service.registry({ projectId: 'p', conversationId: 'c', cwd }, { sendRequest: r => sent.push(r), timeoutMs: 1000 })
  async function save(mode: 'manual' | 'rules' | 'review', excluded = ['.git', '.env']) {
    const response = await service.handle({ action: 'get' }); if (response.kind !== 'state') throw Error('get failed')
    return service.handle({ action: 'save', revision: response.state.revision, policy: { ...emptyPolicy('p'), mode, read: true, write: true, excluded, purpose: '修改專案檔案與測試' } })
  }
  const ask = (path = 'a.ts') => ({ toolName: 'Write', toolUseId: 'tool', executionCwd: cwd, input: { file_path: join(cwd, path), content: 'hello' } })
  return { root, cwd, dir, service, registry, sent, save, ask }
}
const tick = () => new Promise(r => setTimeout(r, 10))

it('未授權預設人工，存檔後工作目錄內寫檔自動允許且重啟保留', async () => {
  const r = await rig(); const p = r.registry.request(r.ask()); await tick()
  await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual')); r.registry.reply(r.sent[0]!.requestId, 'deny'); await p
  await r.save('rules'); expect(await r.registry.request(r.ask())).toMatchObject({ decision: 'allow', source: 'rule' })
  const reloaded = await createPermissionService(r.dir, async () => { throw Error('no model') }, () => true, () => {}); services.push(reloaded)
  expect(await reloaded.handle({ action: 'get' })).toMatchObject({ kind: 'state', state: { revision: 1, policies: [{ mode: 'rules' }] } })
})

it('共同批准關卡直接拒絕 Claude/Codex Bash 與 Grok rawInput 的受管服務停止指令', async () => {
  const message = '這是 YesChef 管理的執行中服務，請使用者在『執行』面板操作'
  const r = await rig(undefined, undefined, () => [{ pid: 8123, pgid: 8100, processName: 'node', port: 3000 }])
  for (const request of [
    { toolName: 'Bash', toolUseId: 'claude', input: { command: 'kill -9 8123' } },
    { toolName: 'Bash', toolUseId: 'codex', input: { command: 'lsof -ti :3000 | xargs kill' } },
    { toolName: '執行 npm run dev', toolUseId: 'grok', input: { command: 'fuser -k 3000/tcp' } },
  ]) {
    await expect(r.registry.request(request)).resolves.toEqual({ decision: 'deny', source: 'system', reason: message })
  }
  expect(r.sent).toHaveLength(0)
})

it('沒有受管服務時 Bash 的一般批准流程不變', async () => {
  const r = await rig()
  const pending = r.registry.request({ toolName: 'Bash', toolUseId: 'query', input: { command: 'lsof -i :3000' } })
  await vi.waitFor(() => expect(r.sent).toHaveLength(1))
  r.registry.reply(r.sent[0]!.requestId, 'deny')
  await expect(pending).resolves.toMatchObject({ decision: 'deny' })
  const response = await r.service.handle({ action: 'get' })
  expect(response).toMatchObject({ kind: 'state', audit: [expect.objectContaining({ decision: 'deny', source: 'user' })] })
})

it('載入的舊 MCP 審核紀錄以 YesChef 工具名稱呈現', async () => {
  const r = await rig()
  await r.service.dispose()
  await writeFile(join(r.dir, 'audit.json'), JSON.stringify([{
    id: 'audit-1', at: '2026-10-01T00:00:00.000Z', projectId: 'p', conversationId: 'c',
    tool: 'mcp__sidepane__view_click', decision: 'allow', source: 'rule', reason: '', revision: 1,
    requestHash: 'hash',
  }]))
  const reloaded = await createPermissionService(r.dir, async () => { throw Error('no model') }, () => true, () => {})
  services.push(reloaded)
  await expect(reloaded.handle({ action: 'get' })).resolves.toMatchObject({
    kind: 'state', audit: [{ tool: 'mcp__yeschef__view_click' }],
  })
})
it('禁止路徑優先，立即人工允許也不能繞過；暫停不解除禁止', async () => {
  const r = await rig(); await r.save('rules')
  const p = r.registry.request(r.ask('.env')); r.registry.reply(r.sent[0]!.requestId, 'allow')
  expect(await p).toMatchObject({ decision: 'deny', source: 'rule' })
  await r.service.handle({ action: 'pause', revision: 1, paused: true })
  expect(await r.registry.request(r.ask('.env'))).toMatchObject({ decision: 'deny' })
})
it('自動允許不涵蓋 shell、跨根目錄、符號連結與缺差異的寫檔', async () => {
  const r = await rig(); await r.save('rules')
  await mkdir(join(r.root, 'outside')); await symlink(join(r.root, 'outside'), join(r.cwd, 'link'))
  for (const request of [r.ask('../outside/a'), r.ask('link/a'), { toolName: 'Bash', toolUseId: 't', input: { command: 'echo x > a.ts' } }, { toolName: 'Edit', toolUseId: 't', input: { reason: 'write' } }]) {
    const start = r.sent.length; const promise = r.registry.request(request); await tick()
    await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual'))
    r.registry.reply(r.sent[start]!.requestId, 'deny'); await promise
  }
})
it('規則版本衝突、未知專案及非相對禁止路徑拒絕儲存', async () => {
  const r = await rig(); await r.save('rules')
  for (const request of [
    { action: 'pause', revision: 0, paused: true },
    { action: 'save', revision: 1, policy: emptyPolicy('missing') },
    { action: 'save', revision: 1, policy: { ...emptyPolicy('p'), excluded: ['../outside'] } },
  ]) expect(await r.service.handle(request)).toMatchObject({ kind: 'error' })
})
it('審核使用完整操作，allow 綁定 fingerprint 並記錄來源', async () => {
  const reviewer = vi.fn<Reviewer>(async input => ({ requestHash: input.requestHash, verdict: 'allow', reason: '符合目的' }))
  const r = await rig(reviewer); await r.save('review')
  expect(await r.registry.request(r.ask())).toMatchObject({ decision: 'allow', source: 'review' })
  expect(reviewer.mock.calls[0]![0]).toMatchObject({ purpose: '修改專案檔案與測試', operation: 'write', input: { content: 'hello' } })
  expect(await r.service.handle({ action: 'get' })).toMatchObject({ kind: 'state', audit: [expect.objectContaining({ source: 'review', decision: 'allow' })] })
  await r.service.dispose()
  expect(await readFile(join(r.dir, 'audit.json'), 'utf8')).not.toContain('hello')
})
it('人工接管後忽略審核者的遲到 allow，僅結算一次', async () => {
  let finish!: (result: ReviewResult) => void; let inputHash = ''; let signal!: AbortSignal
  const r = await rig((input, s) => { inputHash = input.requestHash; signal = s; return new Promise(resolve => { finish = resolve }) })
  await r.save('review'); const p = r.registry.request(r.ask()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const id = r.sent[0]!.requestId; expect(r.registry.reply(id, 'deny')).toBe(true)
  expect(await p).toMatchObject({ decision: 'deny' }); expect(signal.aborted).toBe(true)
  finish({ requestHash: inputHash, verdict: 'allow', reason: 'too late' }); await tick()
  expect(r.registry.pendingCount()).toBe(0); expect(r.registry.reply(id, 'allow')).toBe(false)
})
it('審核中修改檔案，原本 allow 轉回人工', async () => {
  let finish!: () => void
  const r = await rig(input => new Promise(resolve => { finish = () => resolve({ requestHash: input.requestHash, verdict: 'allow', reason: 'ok' }) }))
  await r.save('review'); const p = r.registry.request(r.ask()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await writeFile(join(r.cwd, 'a.ts'), 'changed elsewhere'); finish(); await vi.waitFor(() => expect(r.sent.at(-1)?.reviewReason).toContain('已改變'))
  r.registry.reply(r.sent[0]!.requestId, 'deny'); await p
})
it('撤銷／暫停會取消進行中審核，不能沿用原 allow', async () => {
  let started = false
  const r = await rig((_input, signal) => new Promise((_resolve, reject) => { started = true; signal.addEventListener('abort', () => reject(Error('aborted'))) }))
  await r.save('review'); const p = r.registry.request(r.ask()); await vi.waitFor(() => expect(started).toBe(true))
  await r.service.handle({ action: 'pause', revision: 1, paused: true }); await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual'))
  r.registry.reply(r.sent[0]!.requestId, 'deny'); await p
})
it('錯誤審核 hash、無效 JSON 與模型失敗均轉人工', async () => {
  for (const reviewer of [async () => ({ requestHash: 'wrong', verdict: 'allow' as const, reason: 'ok' }), async () => { throw Error('offline') }]) {
    const r = await rig(reviewer); await r.save('review'); const p = r.registry.request(r.ask())
    await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual')); r.registry.reply(r.sent[0]!.requestId, 'deny'); await p
  }
})
it('Codex 完整差異可判斷；缺少 kind、刪除或改名保留人工', async () => {
  const r = await rig()
  const request = { requestId: 'r', toolName: 'Edit', toolUseId: 't', input: { changes: [{ path: 'new.ts', kind: { type: 'add' }, diff: '+ hello' }] } }
  expect(await collectEvidence(request, r.cwd)).toMatchObject({ operation: 'write', paths: [join(r.cwd, 'new.ts')] })
  expect(await collectEvidence({ ...request, input: { ...request.input, grantRoot: '/outside' } }, r.cwd)).toBeNull()
  for (const kind of [{ type: 'delete' }, { type: 'update', move_path: '/outside' }, {}]) {
    expect(await collectEvidence({ ...request, input: { changes: [{ path: 'x', diff: 'hello', kind }] } }, r.cwd)).toBeNull()
  }
})
it('批准总期限會取消未完成的審核並釋放 pending', async () => {
  const evaluate = vi.fn(async (_r, signal: AbortSignal) => new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null))))
  const registry = createApprovalRegistry({ timeoutMs: 20, sendRequest: () => {}, evaluate })
  const result = await registry.request({ toolName: 'Read', toolUseId: 't', input: {} })
  expect(result).toMatchObject({ decision: 'deny', source: 'system' }); expect(registry.pendingCount()).toBe(0)
})
it('檔案證據在 provider 回報完成後失效，審核 allow 不得執行', async () => {
  let finish!: () => void; let valid = true
  const r = await rig(input => new Promise(resolve => { finish = () => resolve({ requestHash: input.requestHash, verdict: 'allow', reason: 'ok' }) }))
  await r.save('review'); const p = r.registry.request({ ...r.ask(), validateEvidence: () => valid })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); valid = false; finish()
  await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual'))
  r.registry.reply(r.sent[0]!.requestId, 'deny'); await p
})
it('同專案已有審核時，第二筆轉人工且不額外啟動模型', async () => {
  let finish!: () => void
  const reviewer = vi.fn<Reviewer>(input => new Promise(resolve => { finish = () => resolve({ requestHash: input.requestHash, verdict: 'allow', reason: 'ok' }) }))
  const r = await rig(reviewer); await r.save('review')
  const first = r.registry.request(r.ask()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const secondStart = r.sent.length; const second = r.registry.request({ ...r.ask('b.ts'), toolUseId: 'second' })
  await vi.waitFor(() => expect(r.sent.at(-1)?.reviewReason).toContain('已有審核'))
  expect(reviewer).toHaveBeenCalledOnce(); r.registry.reply(r.sent[secondStart]!.requestId, 'deny'); await second
  finish(); expect(await first).toMatchObject({ decision: 'allow' })
})
it('人工批准的最終提交仍可被剛變更的政策阻擋', async () => {
  let finish!: (outcome: null) => void; let allowed = true
  const registry = createApprovalRegistry({ sendRequest: () => {}, createRequestId: () => 'r',
    validateAllow: () => new Promise(resolve => { finish = resolve }),
    finalize: outcome => outcome.decision === 'allow' && !allowed ? { decision: 'deny', reason: 'revoked' } : outcome,
  })
  const promise = registry.request({ toolName: 'Write', toolUseId: 't', input: {} })
  expect(registry.reply('r', 'allow')).toBe(true); allowed = false; finish(null)
  expect(await promise).toEqual({ decision: 'deny', reason: 'revoked' })
})

it('沒有 Codex 檔案差異的請求仍能由使用者明確批准', async () => {
  const r = await rig(); await r.save('review')
  const pending = r.registry.request({ toolName: 'Edit', toolUseId: 'f', input: { reason: '額外寫入權限' } })
  await vi.waitFor(() => expect(r.sent.at(-1)?.reviewStatus).toBe('manual'))
  r.registry.reply(r.sent[0]!.requestId, 'allow')
  expect(await pending).toMatchObject({ decision: 'allow', source: 'user' })
})

it('稽核紀錄附上 summary，舊格式缺少 summary 仍能載入', async () => {
  const r = await rig(); await r.save('rules')
  expect(await r.registry.request(r.ask('a.ts'))).toMatchObject({ decision: 'allow' })
  const withSummary = await r.service.handle({ action: 'get' })
  expect(withSummary).toMatchObject({ kind: 'state', audit: [expect.objectContaining({ tool: 'Write', summary: expect.stringContaining('a.ts') })] })
  await r.service.dispose()
  const legacy = (JSON.parse(await readFile(join(r.dir, 'audit.json'), 'utf8')) as Record<string, unknown>[])
    .map(({ summary: _summary, ...rest }) => rest)
  await writeFile(join(r.dir, 'audit.json'), JSON.stringify(legacy))
  const reloaded = await createPermissionService(r.dir, async () => { throw Error('no model') }, () => true, () => {})
  services.push(reloaded)
  expect(await reloaded.handle({ action: 'get' })).toMatchObject({ kind: 'state', audit: [expect.objectContaining({ tool: 'Write' })] })
})

it('匯出：呼叫 showSaveDialog 帶預設檔名，未取消則寫入該專案紀錄且最新在前', async () => {
  const dialogArgs: unknown[] = []
  let filePath = ''
  const showSaveDialog = vi.fn(async (options: { defaultPath: string; title: string; filters: { name: string; extensions: string[] }[] }) => { dialogArgs.push(options); return { canceled: false, filePath } })
  const r = await rig(async input => ({ requestHash: input.requestHash, verdict: 'allow', reason: '符合目的' }), showSaveDialog)
  filePath = join(r.root, 'export.json')
  await r.save('rules')
  await r.registry.request(r.ask('a.ts'))
  await r.registry.request({ ...r.ask('b.ts'), toolUseId: 'tool-2' })
  const response = await r.service.handle({ action: 'export', projectId: 'p' })
  expect(response).toMatchObject({ kind: 'exported', path: filePath })
  expect(dialogArgs[0]).toMatchObject({ defaultPath: expect.stringMatching(/^yeschef-授權紀錄-p-\d{4}-\d{2}-\d{2}\.json$/) })
  const written = JSON.parse(await readFile(filePath, 'utf8')) as { at: string }[]
  expect(written.length).toBe(2)
  expect(new Date(written[0]!.at).getTime()).toBeGreaterThanOrEqual(new Date(written[1]!.at).getTime())
})

it('匯出：使用者取消時不寫入檔案，回傳現有狀態', async () => {
  const showSaveDialog = vi.fn(async () => ({ canceled: true }))
  const r = await rig(undefined, showSaveDialog)
  await r.save('rules')
  const response = await r.service.handle({ action: 'export', projectId: 'p' })
  expect(response).toMatchObject({ kind: 'state' })
})

it('匯出：未注入 showSaveDialog 時回傳錯誤', async () => {
  const r = await rig()
  expect(await r.service.handle({ action: 'export', projectId: 'p' })).toMatchObject({ kind: 'error' })
})
