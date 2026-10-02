import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from '@yeschef/error-intake'
import { createErrorIntakeService, writerUsername, type ErrorIntakePool, type ErrorIntakePoolOptions } from '../src/main/error-intake/service.js'
import type { SafeStorageLike } from '../src/main/error-intake/store.js'

class FakePool implements ErrorIntakePool {
  constructor(private readonly database: FakeDatabase) {}

  async query(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.database.calls.push({ sql, values })
    if (this.database.failOn !== undefined && sql.includes(this.database.failOn)) {
      throw Object.assign(new Error(this.database.failMessage), { code: this.database.failCode ?? 'ER_ACCESS_DENIED_ERROR' })
    }
    if (sql.includes('SHOW GRANTS')) return [this.database.grants, []]
    if (sql.includes('INSERT INTO error_intake_meta')) {
      this.database.schemaVersion = SCHEMA_VERSION
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('SELECT schema_version')) {
      const rows = this.database.schemaVersion === null ? [] : [{ schema_version: this.database.schemaVersion }]
      return [rows, []]
    }
    if (sql.includes('SELECT source, error_type, route, environment FROM error_group')) return [this.database.errorGroups, []]
    if (sql.includes('group_id IN (SELECT id FROM error_group')) return [{ affectedRows: 1 }, []]
    if (sql.includes('DELETE FROM error_event')) return [{ affectedRows: 3 }, []]
    if (sql.includes('DELETE FROM error_group')) return [{ affectedRows: 2 }, []]
    return [{ affectedRows: 0 }, []]
  }

  async end(): Promise<void> { this.database.closedPools += 1 }
}

interface FakeDatabase {
  grants: readonly Record<string, string>[]
  schemaVersion: number | null
  failOn?: string
  failMessage: string
  failCode?: string
  calls: { readonly sql: string; readonly values: readonly unknown[] }[]
  errorGroups: readonly Record<string, unknown>[]
  closedPools: number
}

const ADMIN_GRANTS = [{ grants: 'GRANT ALL PRIVILEGES ON *.* TO `admin`@`%` WITH GRANT OPTION' }]
const SECRET = 'do-not-leak-this-password'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeService(options: {
  readonly grants?: readonly Record<string, string>[]
  readonly safeAvailable?: boolean
  readonly failOn?: string
  readonly failMessage?: string
  readonly setInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout
  readonly clearInterval?: (timer: NodeJS.Timeout) => void
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'error-intake-test-'))
  directories.push(dir)
  const database: FakeDatabase = {
    grants: options.grants ?? ADMIN_GRANTS,
    schemaVersion: null,
    ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
    failMessage: options.failMessage ?? 'database error',
    calls: [],
    errorGroups: [],
    closedPools: 0,
  }
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => options.safeAvailable ?? true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      const text = value.toString()
      if (!text.startsWith('encrypted:')) throw new Error('bad cipher')
      return text.slice('encrypted:'.length)
    },
  }
  const logs: Error[] = []
  const poolOptions: ErrorIntakePoolOptions[] = []
  const service = createErrorIntakeService({
    dir,
    safeStorage,
    logError: (error) => logs.push(error),
    poolFactory: (poolOptionsArg) => { poolOptions.push(poolOptionsArg); return new FakePool(database) },
    ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
    ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
  })
  return { service, database, logs, poolOptions, dir }
}

async function configure(service: ReturnType<typeof createErrorIntakeService>, password = SECRET) {
  return service.handle({ action: 'save', settings: {
    host: 'mysql.local', port: 3306, database: 'errors', tls: true, adminUsername: 'admin', adminPassword: password,
  } })
}

describe('error intake settings and database service', () => {
  it('密碼以 safeStorage 密文保存，settings 與 IPC 回應不含密碼或密文', async () => {
    const { service, dir } = await makeService()
    const saved = await configure(service)
    expect(saved).toMatchObject({ kind: 'settings', settings: { hasAdminPassword: true } })
    const disk = await readFile(join(dir, 'error-intake.json'), 'utf8')
    expect(disk).not.toContain(SECRET)
    const view = await service.handle({ action: 'get' })
    expect(JSON.stringify(view)).not.toContain(SECRET)
    expect(JSON.stringify(view)).not.toContain('encrypted:')
    expect(view).toMatchObject({ kind: 'settings', settings: { hasAdminPassword: true } })
  })

  it('Keychain 不可用時拒絕儲存密碼且不建立設定檔', async () => {
    const { service, dir } = await makeService({ safeAvailable: false })
    await expect(configure(service)).resolves.toEqual({ kind: 'error', message: 'Keychain 無法使用，未儲存密碼' })
    await expect(readFile(join(dir, 'error-intake.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('初始化會跑 migration、確認 schema 版本並授予 ei_yeschef 權限', async () => {
    const { service, database, poolOptions } = await makeService()
    await configure(service)
    const initialized = await service.handle({ action: 'initialize' })
    expect(initialized).toMatchObject({ kind: 'initialized', status: { connected: true, passwordNeedsReentry: false, schemaVersion: SCHEMA_VERSION } })
    expect(database.calls.filter((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS'))).toHaveLength(3)
    expect(database.calls.filter((call) => call.sql.startsWith('GRANT'))).toHaveLength(3)
    expect(database.calls.find((call) => call.values.includes('error_intake_meta'))?.sql).toContain('SELECT')
    expect(poolOptions[0]).toMatchObject({ host: 'mysql.local', port: 3306, ssl: { rejectUnauthorized: true } })
  })

  it('app 帳號已存在時再初始化，重設密碼並補上權限，不刪帳號', async () => {
    const { service, database } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    // 帳號的權限可能在 app 以外被改掉；原本再初始化只 ALTER 密碼，帳號仍然沒有權限。
    const callStart = database.calls.length
    await expect(service.handle({ action: 'initialize' })).resolves.toMatchObject({ kind: 'initialized' })
    const calls = database.calls.slice(callStart)
    expect(calls.some(call => call.sql === 'ALTER USER ?@? IDENTIFIED BY ?' && call.values[0] === 'ei_yeschef')).toBe(true)
    const grants = calls.filter(call => call.sql.startsWith('GRANT'))
    expect(grants).toHaveLength(3)
    expect(grants.every(call => call.values[0] === 'errors' && call.values[2] === 'ei_yeschef')).toBe(true)
    expect(calls.some(call => /DROP USER|CREATE USER/.test(call.sql))).toBe(false)
  })

  it('權限不足時列出缺少的權限並停止 migration', async () => {
    const grants = [{ grants: 'GRANT CREATE, CREATE USER ON *.* TO `admin`@`%`' }]
    const { service, database } = await makeService({ grants })
    await configure(service)
    const response = await service.handle({ action: 'initialize' })
    expect(response).toMatchObject({ kind: 'error', message: expect.stringContaining('SELECT') })
    expect(response).toMatchObject({ kind: 'error', message: expect.stringContaining('GRANT OPTION') })
    expect(database.calls.some((call) => call.sql.includes('CREATE TABLE'))).toBe(false)
  })

  it('資料庫層級的 ALL 不會被誤認為全域 CREATE USER', async () => {
    const grants = [{ grants: 'GRANT ALL PRIVILEGES ON `errors`.* TO `admin`@`%` WITH GRANT OPTION' }]
    const { service } = await makeService({ grants })
    await configure(service)
    await expect(service.handle({ action: 'initialize' })).resolves.toMatchObject({
      kind: 'error', message: expect.stringContaining('CREATE USER'),
    })
  })

  it('專案代號符合規則並轉成 MySQL 帳號名稱', async () => {
    expect(writerUsername('orders-api')).toBe('ei_orders_api')
    expect(writerUsername('a'.repeat(28))).toHaveLength(31)
    for (const code of ['', 'Upper', 'has_space', 'a'.repeat(29)]) expect(() => writerUsername(code)).toThrow()
  })

  it('套件來源不符合公開套件或絕對 .tgz 路徑時不保存設定', async () => {
    const { service } = await makeService()
    await expect(service.handle({ action: 'save', settings: {
      host: 'mysql.local', port: 3306, database: 'errors', tls: true, adminUsername: 'admin', packageSource: 'relative.tgz',
    } })).resolves.toMatchObject({ kind: 'error', message: expect.stringContaining('本機 .tgz 絕對路徑') })
    await expect(service.handle({ action: 'get' })).resolves.toMatchObject({
      kind: 'settings', settings: { packageSource: '@yeschef/error-intake' },
    })
  })

  it('建立專案寫入帳號只授予指定表權限，同一代號不能屬於另一專案', async () => {
    const { service, database } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await expect(service.ensureProjectWriter('reserved-project', 'yeschef')).rejects.toThrow('yeschef 為保留的專案代號')
    // 改名前建立的 app 帳號是 ei_sidepane，代號 sidepane 會讓寫入帳號與它同名而被刪除重建。
    await expect(service.ensureProjectWriter('reserved-project', 'sidepane')).rejects.toThrow('sidepane 為保留的專案代號')
    await expect(service.ensureProjectWriter('project-a', 'orders-api')).resolves.toEqual({ projectCode: 'orders-api', username: 'ei_orders_api' })
    await expect(service.projectState('project-a', 'orders-api')).resolves.toMatchObject({
      enabled: false, projectCode: 'orders-api', projectCodeLocked: true,
    })
    const writerGrants = database.calls.filter((call) => call.sql.startsWith('GRANT') && call.values.includes('ei_orders_api'))
    expect(writerGrants.map(({ sql }) => sql)).toEqual([
      'GRANT SELECT, INSERT, UPDATE ON ??.?? TO ?@?',
      'GRANT SELECT, INSERT, DELETE ON ??.?? TO ?@?',
      'GRANT SELECT ON ??.?? TO ?@?',
    ])
    await expect(service.ensureProjectWriter('project-b', 'orders-api')).rejects.toThrow('已被其他專案使用')
    await expect(service.ensureProjectWriter('project-a', 'new-name')).rejects.toThrow('不可直接更改')
  })

  it('啟用記錄與 check 查詢使用 ei_yeschef、專案條件和限定時間', async () => {
    const { service, database, poolOptions } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    await service.markProjectEnabled('project-a', 'orders-api', '@yeschef/error-intake')
    database.errorGroups = [{ source: 'server', error_type: 'TypeError', route: '/orders/:id?token=abc', environment: 'production' }]

    await expect(service.checkProjectErrors('project-a', 'orders-api', 15)).resolves.toEqual([{
      source: 'server', error_type: 'TypeError', route: '/orders/:id', environment: 'production',
    }])
    const queryCall = database.calls.find((call) => call.sql.includes('SELECT source, error_type, route, environment'))
    expect(queryCall?.sql).toContain('project = ?')
    expect(queryCall?.sql).toContain('DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE)')
    expect(queryCall?.values).toEqual(['orders-api', 15])
    expect(poolOptions.at(-1)?.user).toBe('ei_yeschef')
    await expect(service.checkProjectErrors('project-a', 'orders-api', 0)).rejects.toThrow('1 到 120')
    await expect(service.checkProjectErrors('project-a', 'orders-api', 121)).rejects.toThrow('1 到 120')
  })

  it('錯誤資料庫查詢失敗時 log 不包含資料庫密碼', async () => {
    const { service, database, logs } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    await service.markProjectEnabled('project-a', 'orders-api', '@yeschef/error-intake')
    database.failOn = 'SELECT source, error_type, route, environment'
    database.failMessage = SECRET

    await expect(service.checkProjectErrors('project-a', 'orders-api', 10)).rejects.toThrow('無法查詢')
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  })

  it('切換資料庫時清除已啟用專案與寫入帳號關聯', async () => {
    const { service } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    await service.markProjectEnabled('project-a', 'orders-api', '@yeschef/error-intake')
    await service.handle({ action: 'save', settings: {
      host: 'other.local', port: 3306, database: 'errors', tls: true, adminUsername: 'admin',
    } })
    await expect(service.enabledProjectCode('project-a')).resolves.toBeUndefined()
    await expect(service.writerConnectionUrl('project-a')).resolves.toBeUndefined()
  })

  it('同一專案再呼叫一次時沿用既有帳號，不重建、不換密碼（已部署的環境還在用舊密碼）', async () => {
    const { service, database } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    const firstUrl = await service.writerConnectionUrl('project-a')
    const callsAfterFirst = database.calls.length
    await expect(service.ensureProjectWriter('project-a', 'orders-api')).resolves.toEqual({ projectCode: 'orders-api', username: 'ei_orders_api' })
    expect(await service.writerConnectionUrl('project-a')).toBe(firstUrl)
    expect(database.calls.slice(callsAfterFirst).some(({ sql }) => /DROP USER|CREATE USER/.test(sql))).toBe(false)
  })

  it('writer connection URL stays inside main process and includes TLS settings', async () => {
    const { service } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    const connection = await service.writerConnectionUrl('project-a')
    expect(connection).toMatch(/^mysql:\/\/ei_orders_api:/)
    expect(connection).toContain('ssl=%7B%22rejectUnauthorized%22%3Atrue%7D')
    expect(JSON.stringify(await service.handle({ action: 'get' }))).not.toContain(connection)
  })

  it('舊密文無法解密時提示重輸，ALTER 舊 app 帳號密碼且保留專案寫入帳號', async () => {
    const { service, database, poolOptions, dir } = await makeService()
    await configure(service)
    await service.handle({ action: 'initialize' })
    await service.ensureProjectWriter('project-a', 'orders-api')
    await service.markProjectEnabled('project-a', 'orders-api', '@yeschef/error-intake')

    const path = join(dir, 'error-intake.json')
    const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const writers = current.projectWriters as { projectId: string; projectCode: string; passwordCiphertext: string }[]
    const enabled = current.enabledProjects as { projectId: string; projectCode: string }[]
    const { appPasswordCiphertext: _appPassword, appUsername: _appUsername, projectWriters: _writers, enabledProjects: _enabled, ...base } = current
    await writeFile(path, JSON.stringify({
      ...base,
      adminPasswordCiphertext: 'unreadable-admin-cipher',
      sidepanePasswordCiphertext: 'unreadable-app-cipher',
      schemaVersion: 0,
      projectWriters: writers.map(({ projectId, ...writer }) => ({ ...writer, sidepaneProjectId: projectId })),
      enabledProjects: enabled.map(({ projectId, ...entry }) => ({ ...entry, sidepaneProjectId: projectId })),
    }))

    const poolsBeforeStatus = poolOptions.length
    await expect(service.handle({ action: 'status' })).resolves.toMatchObject({
      kind: 'status', status: { connected: false, passwordNeedsReentry: true },
    })
    // 密碼解不開時不去連線。
    expect(poolOptions.length).toBe(poolsBeforeStatus)
    await expect(service.handle({ action: 'initialize' })).resolves.toMatchObject({
      kind: 'error', message: '管理者密碼無法解密，請重新輸入密碼',
    })
    await service.handle({ action: 'save', settings: {
      host: 'mysql.local', port: 3306, database: 'errors', tls: true, adminUsername: 'admin', adminPassword: 'reentered-admin',
    } })

    const callStart = database.calls.length
    await expect(service.handle({ action: 'initialize', recovery: true })).resolves.toMatchObject({
      kind: 'initialized', status: { connected: true, passwordNeedsReentry: false },
    })
    const recoveryCalls = database.calls.slice(callStart)
    expect(recoveryCalls.some(call => call.sql === 'ALTER USER ?@? IDENTIFIED BY ?' && call.values[0] === 'ei_sidepane')).toBe(true)
    expect(recoveryCalls.some(call => /DROP USER|CREATE USER|^GRANT|CREATE TABLE|INSERT INTO|DELETE FROM/.test(call.sql))).toBe(false)
    expect(poolOptions.at(-1)?.user).toBe('ei_sidepane')

    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(saved.appUsername).toBe('ei_sidepane')
    expect(typeof saved.appPasswordCiphertext).toBe('string')
    expect(saved.schemaVersion).toBe(0)
    expect(saved).not.toHaveProperty('sidepanePasswordCiphertext')
    expect(saved.projectWriters).toEqual([{ projectId: 'project-a', projectCode: 'orders-api', passwordCiphertext: expect.any(String) }])
    expect(saved.enabledProjects).toEqual([{ projectId: 'project-a', projectCode: 'orders-api' }])
  })

  it('啟動後每 24 小時清理一次並記錄成功筆數', async () => {
    let tick: (() => void) | undefined
    let interval = 0
    const clearInterval = vi.fn()
    const { service, database } = await makeService({
      setInterval: (callback, milliseconds) => { tick = callback; interval = milliseconds; return { unref() {} } as NodeJS.Timeout },
      clearInterval,
    })
    await configure(service)
    await service.handle({ action: 'initialize' })
    service.startCleanupScheduler()
    expect(interval).toBe(24 * 60 * 60 * 1000)
    expect(tick).toBeDefined()
    await service.runCleanup()
    tick?.()
    await service.runCleanup()
    service.stopCleanupScheduler()
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(database.calls.some((call) => call.sql.includes('INTERVAL 30 DAY'))).toBe(true)
    expect(database.calls.filter((call) => call.sql.includes('INTERVAL 30 DAY')).length).toBeGreaterThanOrEqual(4)
    await expect(service.handle({ action: 'status' })).resolves.toMatchObject({
      kind: 'status', status: { lastCleanup: { ok: true, deletedEvents: 4, deletedGroups: 2 } },
    })
  })

  it('清理失敗只記錄安全錯誤並保留失敗狀態', async () => {
    const { service, database, logs } = await makeService({ failOn: 'group_id IN (SELECT id FROM error_group', failMessage: SECRET })
    await configure(service)
    await service.handle({ action: 'initialize' })
    database.failOn = 'group_id IN (SELECT id FROM error_group'
    const result = await service.runCleanup()
    expect(result).toMatchObject({ ok: false, deletedEvents: 3 })
    expect(JSON.stringify(logs)).not.toContain(SECRET)
    await expect(service.handle({ action: 'status' })).resolves.toMatchObject({ status: { lastCleanup: { ok: false } } })
  })

  it('資料庫錯誤不把密碼寫入 log 或回應', async () => {
    const { service, logs } = await makeService({ failOn: 'SHOW GRANTS', failMessage: SECRET })
    await configure(service)
    const response = await service.handle({ action: 'initialize' })
    expect(response).toMatchObject({ kind: 'error', message: '管理者帳號或密碼錯誤' })
    expect(JSON.stringify(response)).not.toContain(SECRET)
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  })

  // 使用者看不到主程序紀錄，畫面要直接說出原因（實機：連接埠填錯只顯示「請檢查設定與主程序紀錄」）。
  it.each([
    ['ECONNREFUSED', '連不到 mysql.local:3306'],
    ['ENOTFOUND', '找不到主機 mysql.local'],
    ['ETIMEDOUT', '連線 mysql.local:3306 逾時'],
    ['ER_ACCESS_DENIED_ERROR', '管理者帳號或密碼錯誤'],
    ['ER_BAD_DB_ERROR', '資料庫 errors 不存在'],
    ['HANDSHAKE_SSL_ERROR', 'TLS 連線失敗'],
    ['HANDSHAKE_NO_SSL_SUPPORT', 'MySQL 沒有開啟 TLS'],
    ['ER_SOMETHING_ELSE', '錯誤代碼 ER_SOMETHING_ELSE'],
  ])('連線失敗 %s 時畫面顯示具體原因', async (code, expected) => {
    const { service, database } = await makeService({ failOn: 'SHOW GRANTS', failMessage: SECRET })
    await configure(service)
    database.failCode = code
    const response = await service.handle({ action: 'initialize' })
    expect(response).toMatchObject({ kind: 'error' })
    expect(JSON.stringify(response)).toContain(expected)
    expect(JSON.stringify(response)).not.toContain(SECRET)
  })
})
