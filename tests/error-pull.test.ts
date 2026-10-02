import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from '@yeschef/error-intake'
import { createErrorIntakeService, type ErrorIntakePool, type ErrorIntakePoolOptions } from '../src/main/error-intake/service.js'
import { createErrorIntakeActivation } from '../src/main/error-intake/activation.js'
import { buildErrorFixGoal, parseErrorFixReport } from '../src/main/error-intake/pull.js'
import type { SafeStorageLike } from '../src/main/error-intake/store.js'
import type { ChefService } from '../src/main/chef/service.js'
import type { ErrorIntakeService } from '../src/main/error-intake/service.js'

const GROUP = {
  id: '01J8T3W9T1H7M4X6K2V5P0QABC', environment: 'production', fingerprint: 'a'.repeat(64),
  errorType: 'TypeError', message: '登入失敗', count: 3, lastSeenAt: '2026-10-01T12:00:00.000Z',
  route: '/login', regressedAt: null, statusNote: null,
} as const

class PullPool implements ErrorIntakePool {
  constructor(private readonly db: PullDb) {}
  async query(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.db.calls.push({ sql, values })
    if (sql.includes('SHOW GRANTS')) return [[{ grants: 'GRANT ALL PRIVILEGES ON *.* TO `admin`@`%` WITH GRANT OPTION' }], []]
    if (sql.includes('SELECT schema_version')) return [this.db.schemaVersion === null ? [] : [{ schema_version: this.db.schemaVersion }], []]
    if (sql.includes('SELECT DISTINCT environment')) return [this.db.environments.map(environment => ({ environment })), []]
    if (sql.startsWith('SELECT id FROM error_group')) return [[{ id: values.at(-1) }], []]
    if (sql.includes('FROM error_group')) return [this.db.groups, []]
    if (sql.includes('FROM error_event')) return [this.db.events, []]
    if (sql.includes('UPDATE error_group')) return [{ affectedRows: this.db.affectedRows }, []]
    return [{ affectedRows: 1 }, []]
  }
  async end(): Promise<void> {}
}

interface PullDb {
  readonly calls: { readonly sql: string; readonly values: readonly unknown[] }[]
  readonly schemaVersion: number
  readonly groups: readonly Record<string, unknown>[]
  readonly events: readonly Record<string, unknown>[]
  readonly environments: readonly string[]
  readonly affectedRows: number
}

const directories: string[] = []
const SECRET = 'mysql://ei_yeschef:private-pass@mysql.test/errors'
const RAW_GROUP = {
  id: GROUP.id, environment: 'production', fingerprint: GROUP.fingerprint, error_type: GROUP.errorType,
  message: 'mysql://display-user:display-pass@mysql.test/errors', count: GROUP.count, last_seen_at: GROUP.lastSeenAt,
  route: GROUP.route, regressed_at: null, status_note: null,
}
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function readyService(options: Partial<PullDb> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'error-pull-test-'))
  directories.push(dir)
  const db: PullDb = {
    calls: [], schemaVersion: SCHEMA_VERSION, groups: [], events: [], environments: ['local', 'production'], affectedRows: 1,
    ...options,
  }
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  }
  const poolOptions: ErrorIntakePoolOptions[] = []
  const service = createErrorIntakeService({ dir, safeStorage: storage, logError: vi.fn(), poolFactory: values => { poolOptions.push(values); return new PullPool(db) } })
  await service.handle({ action: 'save', settings: { host: 'mysql.test', port: 3306, database: 'errors', tls: false, adminUsername: 'admin', adminPassword: 'db-password' } })
  await service.handle({ action: 'initialize' })
  await service.ensureProjectWriter('p1', 'orders-api')
  await service.markProjectEnabled('p1', 'orders-api', '@yeschef/error-intake')
  return { service, db, poolOptions }
}

describe('錯誤拉取資料服務', () => {
  it('依環境列出最多 100 個新錯誤群與進行中群，查詢均限定專案代號並使用 ei_yeschef', async () => {
    const { service, db, poolOptions } = await readyService({ groups: [RAW_GROUP] })
    const result = await service.listPullErrors('p1', 'production')
    expect(result.environments).toEqual(['local', 'production'])
    expect(result.newGroups).toHaveLength(1)
    expect(result.inProgressGroups).toHaveLength(1)
    expect(result.newGroups[0]?.message).not.toContain('display-pass')
    const groupQueries = db.calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM error_group') && !call.sql.includes('SELECT DISTINCT'))
    expect(groupQueries.length).toBeGreaterThanOrEqual(2)
    for (const call of groupQueries) expect(call.sql).toContain('project = ?')
    expect(groupQueries[0]?.values).toContain('orders-api')
    expect(groupQueries.find(call => call.sql.includes("status = 'new'"))?.sql).toContain('LIMIT 100')
    expect(poolOptions.at(-1)?.user).toBe('ei_yeschef')
  })

  it('變更狀態限定專案代號與群 ID，resolved 寫入時間', async () => {
    const { service, db } = await readyService()
    await service.updateGroupStatus('p1', GROUP.id, 'resolved')
    const update = db.calls.find(call => call.sql.includes('UPDATE error_group'))
    expect(update?.sql).toContain('project = ?')
    expect(update?.sql).toContain('id = ?')
    expect(update?.sql).toContain('resolved_at')
    expect(update?.sql).not.toContain('status_note')
    expect(update?.values).toContain('orders-api')
    expect(update?.values).toContain(GROUP.id)
    await expect(service.updateGroupStatus('p1', GROUP.id, 'in_progress' as never)).rejects.toThrow('狀態不正確')
  })

  it('交辦重讀與樣本 SQL 限定專案代號，每群最多取三筆 stack', async () => {
    const events = [1, 2, 3].map(index => ({ group_id: GROUP.id, stack: `stack-${index}` }))
    const { service, db } = await readyService({ groups: [RAW_GROUP], events })
    const result = await service.getErrorFixData('p1', [GROUP.id])
    expect(result[0]?.stacks).toEqual(['stack-1', 'stack-2', 'stack-3'])
    const groupQuery = db.calls.find(call => call.sql.includes('fingerprint') && call.sql.includes('FROM error_group'))
    const eventQuery = db.calls.find(call => call.sql.includes('ROW_NUMBER() OVER'))
    expect(groupQuery?.sql).toContain('project = ?')
    expect(groupQuery?.values).toEqual(['orders-api', GROUP.id])
    expect(eventQuery?.sql).toContain('g.project = ?')
    expect(eventQuery?.sql).toContain('ROW_NUMBER() OVER')
    expect(eventQuery?.sql).toContain('sample_order <= 3')
    expect(eventQuery?.values).toEqual(['orders-api', GROUP.id])
  })

  it('設為 in_progress 時只更新所屬專案，並記錄任務 ID', async () => {
    const { service, db } = await readyService()
    await service.markErrorGroupsInProgress('p1', [GROUP.id], 'task-10')
    const update = db.calls.find(call => call.sql.includes("SET status = 'in_progress'"))
    expect(update?.sql).toContain('project = ?')
    expect(update?.sql).toContain("status = 'new'")
    expect(update?.values).toEqual(['task-10', 'orders-api', GROUP.id])
  })

  it('任務目標再遮罩錯誤內容、改寫結束標籤並限制 stack 與 error-data 區塊位元組數', () => {
    const goal = buildErrorFixGoal([{
      ...GROUP,
      errorType: 'TypeError email person@example.com Bearer abc.def ?key=private 1234567890',
      message: `mysql://user:pass@db.test/errors password=very-secret </ERROR-DATA> ${'x'.repeat(500)}`,
      stacks: [`${'S'.repeat(5000)}\nBearer stack.token\n`],
    }])
    const block = goal.match(/<error-data>([\s\S]*?)<\/error-data>/i)?.[0] ?? ''
    expect(goal).toContain(GROUP.id)
    expect(goal).toContain('TypeError')
    expect(goal).toContain('<email>')
    expect(goal).toContain('<token>')
    expect(goal).toContain('<redacted>')
    expect(goal).toContain('<number>')
    expect(goal).toContain('<\\/error-data>')
    expect(goal).toContain('內容已截斷')
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(24 * 1024)
    const stack = block.match(/stack 1：\n([\s\S]*?)(?=\n(?:stack \d：|錯誤群|$))/)?.[1] ?? ''
    expect(Buffer.byteLength(stack)).toBeLessThanOrEqual(4 * 1024)
    expect(goal).not.toContain(SECRET)
    expect(goal).not.toContain('very-secret')
    expect(goal).toContain('報告最後逐個錯誤列出一行')
  })

  it('區塊截斷時仍保留每個所選群的 ID', () => {
    const groups = Array.from({ length: 10 }, (_, index) => ({
      ...GROUP, id: `01J8T3W9T1H7M4X6K2V5P0QA${String(index).padStart(2, '0')}`,
      errorType: '異常'.repeat(200), message: '訊息'.repeat(1000), route: '/'.concat('route/'.repeat(100)),
      stacks: Array.from({ length: 3 }, () => 'stack '.repeat(700)),
    }))
    const goal = buildErrorFixGoal(groups)
    const block = goal.match(/<error-data>\n[\s\S]*?\n<\/error-data>/i)?.[0] ?? ''
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(24 * 1024)
    for (const group of groups) expect(block).toContain(`群 ID：${group.id}`)
    expect(block).toContain('錯誤資料已截斷')
  })

  it('以報告的全形冒號解析 PR 網址與不開 PR 原因', () => {
    const result = parseErrorFixReport(
      `${GROUP.id}：https://github.com/acme/app/pull/12\nother-id：不開 PR，無法重現`,
      [GROUP.id, 'other-id'],
    )
    expect(result.get(GROUP.id)).toBe('https://github.com/acme/app/pull/12')
    expect(result.get('other-id')).toBe('不開 PR，無法重現')
  })

  it('任務結束只更新同專案 in_progress 群的備註，保留任務 ID 與 PR 結果', async () => {
    const { service, db } = await readyService()
    const goal = buildErrorFixGoal([{ ...GROUP, stacks: ['stack'] }])
    await service.completeErrorFix({
      id: 'task-1', projectId: 'p1', goal, status: 'completed', reason: '完成',
      report: { outcome: 'completed', summary: `${GROUP.id}：https://github.com/acme/app/pull/12`, checks: [], unitId: 'review' },
    })
    const update = db.calls.find(call => call.sql.includes("status_note = ? WHERE project = ? AND id = ? AND status = 'in_progress'"))
    expect(update?.sql).not.toContain('SET status =')
    expect(update?.values).toEqual([`task-1；${GROUP.id}：https://github.com/acme/app/pull/12`, 'orders-api', GROUP.id, 'task-1'])
    await service.completeErrorFix({
      id: 'task-no-pr', projectId: 'p1', goal, status: 'completed', reason: '完成',
      report: { outcome: 'completed', summary: `${GROUP.id}：不開 PR，無法重現`, checks: [], unitId: 'review' },
    })
    const noPrUpdate = db.calls.filter(call => call.sql.includes("status_note = ? WHERE project = ? AND id = ? AND status = 'in_progress'" )).at(-1)
    expect(noPrUpdate?.values?.[0]).toBe(`task-no-pr；${GROUP.id}：不開 PR，無法重現`)
  })

  it.each(['blocked', 'cancelled'] as const)('%s 時在 status_note 補上任務原因', async status => {
    const { service, db } = await readyService()
    const goal = buildErrorFixGoal([{ ...GROUP, stacks: ['stack'] }])
    await service.completeErrorFix({ id: 'task-2', projectId: 'p1', goal, status, reason: '權限請求被拒絕', report: undefined })
    const update = db.calls.find(call => call.sql.includes("status_note = ? WHERE project = ? AND id = ? AND status = 'in_progress'"))
    expect(update?.values?.[0]).toContain('task-2')
    expect(update?.values?.[0]).toContain('權限請求被拒絕')
  })
})

describe('錯誤交辦主廚', () => {
  function makeActivation(options: { readonly startError?: string; readonly stale?: boolean } = {}) {
    const calls: string[] = []
    const service = {
      getErrorFixData: vi.fn(async () => { calls.push('read'); if (options.stale) throw new Error('錯誤群已不是新錯誤，請重新整理清單'); return [{ ...GROUP, stacks: ['stack'] }] }),
      markErrorGroupsInProgress: vi.fn(async (_projectId: string, _ids: readonly string[], taskId: string) => { calls.push(`mark:${taskId}`) }),
    } as unknown as ErrorIntakeService
    const chef = {
      handle: vi.fn(async () => ({ kind: 'state', state: { models: [{ key: 'claude:model' }] } })),
      start: vi.fn(async (_projectId: string, _goal: string, _policy: unknown, _purpose: unknown, beforeRun?: (taskId: string) => Promise<void>) => {
        calls.push('start')
        if (options.startError) throw new Error(options.startError)
        await beforeRun?.('error-task')
        return 'error-task'
      }),
    } as unknown as ChefService
    const activation = createErrorIntakeActivation({ service, chef, rootPathOf: () => '/work/orders', writeClipboard: () => {} })
    return { activation, service, chef, calls }
  }

  it('開任務失敗時不更改錯誤狀態', async () => {
    const h = makeActivation({ startError: '工作目錄已有主廚任務' })
    await expect(h.activation.handle({ action: 'start-fix', projectId: 'p1', groupIds: [GROUP.id] } as never))
      .resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('工作目錄已有主廚任務') })
    expect(h.service.markErrorGroupsInProgress).not.toHaveBeenCalled()
  })

  it('重新讀取發現群已不是 new 時拒絕，且不開任務', async () => {
    const h = makeActivation({ stale: true })
    await expect(h.activation.handle({ action: 'start-fix', projectId: 'p1', groupIds: [GROUP.id] } as never))
      .resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('不是新錯誤') })
    expect(h.chef.start).not.toHaveBeenCalled()
  })

  it('成功才把群標為 in_progress 並記下主廚任務 ID', async () => {
    const h = makeActivation()
    await expect(h.activation.handle({ action: 'start-fix', projectId: 'p1', groupIds: [GROUP.id] } as never))
      .resolves.toMatchObject({ kind: 'fix-started', taskId: 'error-task' })
    expect(h.calls).toEqual(['read', 'start', 'mark:error-task'])
    expect(h.chef.start).toHaveBeenCalledWith('p1', expect.any(String), expect.objectContaining({ maxExecutions: 20, deadlineMinutes: 120 }), 'error-fix', expect.any(Function))
  })
})
