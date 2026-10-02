import { describe, expect, it, vi } from 'vitest'
import type { ChefService } from '../src/main/chef/service.js'
import { createErrorIntakeActivation } from '../src/main/error-intake/activation.js'
import type { ErrorIntakeService } from '../src/main/error-intake/service.js'

const SECRET = 'mysql://ei_order:never-show-this@db.test/errors'

function harness(options: { readonly ready?: boolean; readonly startError?: string } = {}) {
  let enabled = false
  let packageSource = '@yeschef/error-intake'
  let writerCreated = false
  const order: string[] = []
  const service = {
    projectState: vi.fn(async () => ({ defaultProjectCode: 'demo-app', enabled, projectCode: enabled ? 'demo-app' : writerCreated ? 'demo-app' : null, projectCodeLocked: writerCreated, databaseReady: options.ready ?? true })),
    handle: vi.fn(async () => ({ kind: 'settings' as const, settings: { packageSource } })),
    ensureProjectWriter: vi.fn(async (_id: string, code: string) => {
      if (!/^[a-z0-9-]{1,28}$/.test(code)) throw new Error('專案代號格式不正確')
      if (code === 'yeschef') throw new Error('yeschef 為保留的專案代號')
      writerCreated = true; order.push('writer')
    }),
    markProjectEnabled: vi.fn(async (_id: string, _code: string, source: string) => {
      enabled = true; packageSource = source; order.push('marked')
    }),
    rollbackProjectEnable: vi.fn(async () => { enabled = false; packageSource = '@yeschef/error-intake'; order.push('rollback') }),
    isReady: vi.fn(async () => options.ready ?? true),
    enabledProjectCode: vi.fn(async () => enabled ? 'demo-app' : undefined),
    writerConnectionUrl: vi.fn(async () => SECRET),
    checkProjectErrors: vi.fn(async () => []),
  } as unknown as ErrorIntakeService
  const chef = {
    handle: vi.fn(async () => ({ kind: 'state', state: { models: [{ key: 'claude:sonnet' }, { key: 'codex:gpt' }] } })),
    start: vi.fn(async (_id: string, goal: string, policy: unknown, purpose: unknown) => {
      order.push('task')
      if (options.startError !== undefined) throw new Error(options.startError)
      return 'task-1'
    }),
  } as unknown as ChefService
  const activation = createErrorIntakeActivation({ service, chef, rootPathOf: () => '/work/demo-app', writeClipboard: () => {} })
  return { activation, service, chef, order, enabled: () => enabled, writerCreated: () => writerCreated, packageSource: () => packageSource }
}

describe('錯誤收集啟用', () => {
  it('未確認模型供應商傳輸前不建立帳號或任務', async () => {
    const h = harness()
    await expect(h.activation.handle({ action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: false, packageSource: '@yeschef/error-intake' }))
      .resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('確認') })
    expect(h.service.ensureProjectWriter).not.toHaveBeenCalled()
  })

  it('資料庫未初始化或 schema 版本不正確時不能啟用', async () => {
    const h = harness({ ready: false })
    await expect(h.activation.handle({ action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true, packageSource: '@yeschef/error-intake' }))
      .resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('初始化') })
    expect(h.service.ensureProjectWriter).not.toHaveBeenCalled()
    expect(h.chef.start).not.toHaveBeenCalled()
  })

  it('使用群組的模型池與預設政策建立無密碼、含套件來源的任務', async () => {
    const h = harness()
    const result = await h.activation.handle({
      action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true,
      packageSource: '/tmp/error-intake-1.2.3.tgz',
    })
    expect(result).toMatchObject({ kind: 'enabled', projectId: 'p1', projectCode: 'demo-app', taskId: 'task-1' })
    expect(h.order).toEqual(['writer', 'marked', 'task'])
    const [projectId, goal, policy, purpose] = vi.mocked(h.chef.start).mock.calls[0]!
    expect(projectId).toBe('p1')
    expect(goal).toContain("npm install '/tmp/error-intake-1.2.3.tgz'")
    expect(goal).toContain('node_modules/@yeschef/error-intake/README.md')
    expect(goal).not.toContain(SECRET)
    // 實機驗收：安裝任務拆成 7 個工作單位，群組預設的 8 次用完時總驗收還沒跑。安裝任務給 12 次。
    expect(policy).toEqual({ mode: 'auto', allowed: ['claude:sonnet', 'codex:gpt'], maxExecutions: 12, deadlineMinutes: 120 })
    expect(purpose).toBe('error-intake-setup')
    expect(h.enabled()).toBe(true)
  })

  it('同專案已有主廚任務時回傳 chef 錯誤並回復啟用狀態', async () => {
    const h = harness({ startError: '工作目錄被主廚任務佔著' })
    const result = await h.activation.handle({
      action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true,
      packageSource: '/tmp/error-intake.tgz',
    })
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('工作目錄被主廚任務') })
    expect(h.writerCreated()).toBe(true)
    expect(h.enabled()).toBe(false)
    expect(h.packageSource()).toBe('@yeschef/error-intake')
    expect(h.order).toEqual(['writer', 'marked', 'task', 'rollback'])
    await expect(h.activation.project('p1')).resolves.toMatchObject({
      kind: 'project', enabled: false, projectCode: 'demo-app', projectCodeLocked: true,
    })
  })

  it('複製連線字串只交給主行程 clipboard，不放進 IPC 結果', async () => {
    const h = harness()
    await h.activation.handle({ action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true, packageSource: '@yeschef/error-intake' })
    const writeClipboard = vi.fn()
    const activation = createErrorIntakeActivation({
      service: h.service, rootPathOf: () => '/work/demo-app', writeClipboard,
    })
    const response = await activation.handle({ action: 'copy-connection', projectId: 'p1' })
    expect(writeClipboard).toHaveBeenCalledWith(SECRET)
    expect(JSON.stringify(response)).not.toContain(SECRET)
    expect(response).toEqual({ kind: 'copied', projectId: 'p1' })
  })
})
