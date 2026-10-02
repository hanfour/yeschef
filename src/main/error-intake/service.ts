import { randomBytes } from 'node:crypto'
import { MIGRATIONS, SCHEMA_VERSION } from '@yeschef/error-intake'
import {
  ErrorIntakeRequestSchema,
  type ErrorIntakeGroup,
  type ErrorIntakeCleanup,
  type ErrorIntakeRequest,
  type ErrorIntakeResponse,
  type ErrorIntakeSettingsInput,
  type ErrorIntakeStatus,
} from '../../shared/error-intake.js'
import {
  assertAdminPermissions, cleanRows, CleanupFailure, connectionFailureMessage, createMysqlPool, ensureUser, grantTables, logDbError, MissingPermissionsError,
  query, readSchemaVersion, readSchemaVersionIfPresent, selectDatabase,
  type ErrorIntakePool, type ErrorIntakePoolOptions,
} from './database.js'
import { createErrorIntakeStore, type SafeStorageLike, type StoredConfig } from './store.js'
import { defaultProjectCode, validatePackageSource } from './goal.js'
import { createErrorIntakePullOperations, ErrorIntakePullError, type ErrorIntakePullOperations, type ErrorIntakeReader } from './pull-database.js'
import {
  buildWriterUrl, clearDatabaseStateOnChange, errorGroups, isDatabaseChanged, replaceWriter,
  settingsView, statusFromConfig, validateProjectCode, validateWriterOwnership, writerUsername,
} from './service-helpers.js'

export { writerUsername } from './service-helpers.js'

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
export type { ErrorIntakePool, ErrorIntakePoolOptions } from './database.js'

export interface ErrorIntakeService extends ErrorIntakePullOperations {
  handle(raw: unknown): Promise<ErrorIntakeResponse>
  ensureProjectWriter(projectId: string, projectCode: string): Promise<{ readonly projectCode: string; readonly username: string }>
  writerConnectionUrl(projectId: string): Promise<string | undefined>
  isReady(): Promise<boolean>
  projectState(projectId: string, folderName: string): Promise<{
    readonly defaultProjectCode: string; readonly enabled: boolean; readonly projectCode: string | null
    readonly projectCodeLocked: boolean; readonly databaseReady: boolean
  }>
  enabledProjectCode(projectId: string): Promise<string | undefined>
  markProjectEnabled(projectId: string, projectCode: string, packageSource: string): Promise<void>
  rollbackProjectEnable(projectId: string, packageSource: string): Promise<void>
  checkProjectErrors(projectId: string, projectCode: string, sinceMinutes: number): Promise<readonly ErrorIntakeGroup[]>
  runCleanup(): Promise<ErrorIntakeCleanup | undefined>
  startCleanupScheduler(): void
  stopCleanupScheduler(): void
}

export interface ErrorIntakeServiceDeps {
  readonly dir: string
  readonly safeStorage: SafeStorageLike
  readonly logError: (error: Error) => void
  readonly poolFactory?: (options: ErrorIntakePoolOptions) => ErrorIntakePool
  readonly now?: () => Date
  readonly setInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout
  readonly clearInterval?: (timer: NodeJS.Timeout) => void
}

export function createErrorIntakeService(deps: ErrorIntakeServiceDeps): ErrorIntakeService {
  const service = new ErrorIntakeServiceImpl(deps)
  const reader: ErrorIntakeReader = (projectId, work) => service.withReader(projectId, work)
  return Object.assign(service, createErrorIntakePullOperations(reader))
}

class ErrorIntakeServiceImpl {
  private readonly store: ReturnType<typeof createErrorIntakeStore>
  private readonly poolFactory: NonNullable<ErrorIntakeServiceDeps['poolFactory']>
  private readonly now: () => Date
  private readonly setTimer: NonNullable<ErrorIntakeServiceDeps['setInterval']>
  private readonly clearTimer: NonNullable<ErrorIntakeServiceDeps['clearInterval']>
  private operationTail: Promise<void> = Promise.resolve()
  private cleanupTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: ErrorIntakeServiceDeps) {
    this.store = createErrorIntakeStore(deps)
    this.poolFactory = deps.poolFactory ?? createMysqlPool
    this.now = deps.now ?? (() => new Date())
    this.setTimer = deps.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds) as NodeJS.Timeout)
    this.clearTimer = deps.clearInterval ?? ((timer) => clearInterval(timer))
  }

  handle(raw: unknown): Promise<ErrorIntakeResponse> {
    return this.serial(() => this.handleInternal(raw))
  }

  ensureProjectWriter(projectId: string, projectCode: string): Promise<{ readonly projectCode: string; readonly username: string }> {
    return this.serial(() => this.ensureProjectWriterInternal(projectId, projectCode))
  }

  writerConnectionUrl(projectId: string): Promise<string | undefined> {
    return this.serial(() => this.writerConnectionUrlInternal(projectId))
  }

  isReady(): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.status(await this.store.load())
      return current.connected && current.schemaVersion === SCHEMA_VERSION
    })
  }

  projectState(projectId: string, folderName: string) {
    return this.serial(() => this.projectStateInternal(projectId, folderName))
  }

  enabledProjectCode(projectId: string): Promise<string | undefined> {
    return this.serial(async () => (await this.store.load()).enabledProjects.find((entry) => entry.projectId === projectId)?.projectCode)
  }

  markProjectEnabled(projectId: string, projectCode: string, packageSource: string): Promise<void> {
    return this.serial(() => this.markProjectEnabledInternal(projectId, projectCode, packageSource))
  }

  rollbackProjectEnable(projectId: string, packageSource: string): Promise<void> {
    return this.serial(() => this.rollbackProjectEnableInternal(projectId, packageSource))
  }

  checkProjectErrors(projectId: string, projectCode: string, sinceMinutes: number): Promise<readonly ErrorIntakeGroup[]> {
    return this.serial(() => this.checkProjectErrorsInternal(projectId, projectCode, sinceMinutes))
  }

  withReader<T>(projectId: string, work: (pool: ErrorIntakePool, projectCode: string) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      try {
        const config = await this.store.load()
        const enabled = config.enabledProjects.find(entry => entry.projectId === projectId)
        if (enabled === undefined) throw new ErrorIntakePullError('這個專案尚未啟用錯誤收集')
        if (config.schemaVersion !== SCHEMA_VERSION || config.appPasswordCiphertext === null) {
          throw new ErrorIntakePullError('錯誤資料庫尚未初始化或版本不正確')
        }
        const password = this.store.decrypt(config.appPasswordCiphertext)
        return await this.withPool(this.createPool(config, config.appUsername, password), async pool => {
          if (await readSchemaVersion(pool) !== SCHEMA_VERSION) throw new ErrorIntakePullError('錯誤資料庫 schema 版本不正確')
          return work(pool, enabled.projectCode)
        })
      } catch (raw) {
        if (raw instanceof ErrorIntakePullError) throw raw
        logDbError(this.deps.logError, '錯誤資料庫拉取操作失敗', raw)
        throw new Error('錯誤資料庫無法操作，請確認資料庫連線與版本')
      }
    })
  }

  runCleanup(): Promise<ErrorIntakeCleanup | undefined> {
    return this.serial(() => this.cleanupInternal())
  }

  startCleanupScheduler(): void {
    if (this.cleanupTimer !== undefined) return
    void this.runCleanup().catch(() => {})
    this.cleanupTimer = this.setTimer(() => { void this.runCleanup().catch(() => {}) }, CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  stopCleanupScheduler(): void {
    if (this.cleanupTimer === undefined) return
    this.clearTimer(this.cleanupTimer)
    this.cleanupTimer = undefined
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationTail.then(operation, operation)
    this.operationTail = current.then(() => undefined, () => undefined)
    return current
  }

  private createPool(config: StoredConfig, username: string, password: string, selectDatabase = true): ErrorIntakePool {
    return this.poolFactory({
      host: config.host, port: config.port, ...(selectDatabase ? { database: config.database } : {}),
      user: username, password, connectionLimit: 1, timezone: 'Z',
      ...(config.tls ? { ssl: { rejectUnauthorized: true } } : {}),
    })
  }

  private async withPool<T>(pool: ErrorIntakePool, work: (pool: ErrorIntakePool) => Promise<T>): Promise<T> {
    try { return await work(pool) } finally {
      await pool.end().catch(() => { this.deps.logError(new Error('錯誤資料庫連線關閉失敗')) })
    }
  }

  private async handleInternal(raw: unknown): Promise<ErrorIntakeResponse> {
    const parsed = ErrorIntakeRequestSchema.safeParse(raw)
    if (!parsed.success) return { kind: 'error', message: '錯誤收集資料庫請求格式不正確' }
    try { return await this.handleRequest(parsed.data) } catch (rawError) {
      logDbError(this.deps.logError, '錯誤收集資料庫設定操作失敗', rawError)
      return { kind: 'error', message: '設定操作失敗，請檢查主程序紀錄' }
    }
  }

  private handleRequest(request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> {
    if (request.action === 'get') return this.getSettings()
    if (request.action === 'save') return this.saveSettings(request.settings)
    if (request.action === 'initialize') return this.initialize(request.recovery === true)
    if (request.action === 'status') return this.getStatus()
    return Promise.resolve({ kind: 'error', message: '錯誤收集資料庫請求格式不正確' })
  }

  private async getSettings(): Promise<ErrorIntakeResponse> {
    return { kind: 'settings', settings: settingsView(await this.store.load()) }
  }

  private async getStatus(): Promise<ErrorIntakeResponse> {
    return { kind: 'status', status: await this.status(await this.store.load()) }
  }

  private async status(config: StoredConfig): Promise<ErrorIntakeStatus> {
    const initialized = config.appPasswordCiphertext !== null && config.schemaVersion !== null
    const ciphertext = initialized ? config.appPasswordCiphertext : config.adminPasswordCiphertext
    const username = initialized ? config.appUsername : config.adminUsername
    const passwordNeedsReentry = this.ciphertextUnreadable(config.adminPasswordCiphertext) ||
      (initialized && this.ciphertextUnreadable(config.appPasswordCiphertext))
    if (ciphertext === null) return statusFromConfig(config, false, config.schemaVersion, passwordNeedsReentry)
    // 密碼解不開（例如改名後 Keychain 項目不同）就不用連了，直接請使用者重新輸入，也不記錯誤。
    if (this.ciphertextUnreadable(ciphertext)) return statusFromConfig(config, false, null, true)
    try {
      const password = this.store.decrypt(ciphertext)
      const version = await this.withPool(this.createPool(config, username, password), async (pool) => {
        await query(pool, 'SELECT 1 AS connected')
        return readSchemaVersionIfPresent(pool)
      })
      return statusFromConfig(config, true, version, passwordNeedsReentry)
    } catch (raw) {
      logDbError(this.deps.logError, '錯誤資料庫狀態查詢失敗', raw)
      return statusFromConfig(config, false, null, passwordNeedsReentry || this.ciphertextUnreadable(ciphertext))
    }
  }

  private ciphertextUnreadable(ciphertext: string | null): boolean {
    if (ciphertext === null) return false
    try { this.store.decrypt(ciphertext); return false } catch { return true }
  }

  private async saveSettings(settings: ErrorIntakeSettingsInput): Promise<ErrorIntakeResponse> {
    const current = await this.store.load()
    let packageSource: string
    try { packageSource = validatePackageSource(settings.packageSource ?? current.packageSource) } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : '套件來源格式不正確' }
    }
    const { adminPassword: _adminPassword, ...publicSettings } = settings
    const encrypted = await this.encryptSettingPassword(settings.adminPassword, current.adminPasswordCiphertext)
    if (encrypted.kind === 'error') return encrypted
    const switchedDatabase = isDatabaseChanged(current, settings)
    const next = clearDatabaseStateOnChange({ ...current, ...publicSettings, packageSource, adminPasswordCiphertext: encrypted.value }, switchedDatabase)
    await this.store.save(next)
    return { kind: 'settings', settings: settingsView(next) }
  }

  private async encryptSettingPassword(password: string | undefined, existing: string | null): Promise<{ kind: 'value'; value: string | null } | Extract<ErrorIntakeResponse, { kind: 'error' }>> {
    if (password === undefined) return { kind: 'value', value: existing }
    try { return { kind: 'value', value: this.store.encrypt(password) } } catch (raw) {
      if (raw instanceof Error && raw.message === 'Keychain 不可用') return { kind: 'error', message: 'Keychain 無法使用，未儲存密碼' }
      this.deps.logError(new Error('錯誤資料庫管理者密碼加密失敗'))
      return { kind: 'error', message: '管理者密碼加密失敗，未儲存設定' }
    }
  }

  private async initialize(recovery: boolean): Promise<ErrorIntakeResponse> {
    const config = await this.store.load()
    if (config.adminPasswordCiphertext === null) return { kind: 'error', message: '請先設定管理者密碼' }
    if (!this.deps.safeStorage.isEncryptionAvailable()) return { kind: 'error', message: 'Keychain 無法使用，未建立資料庫帳號' }
    let adminPassword: string
    try { adminPassword = this.store.decrypt(config.adminPasswordCiphertext) } catch {
      return { kind: 'error', message: '管理者密碼無法解密，請重新輸入密碼' }
    }
    const createAppAccount = config.appPasswordCiphertext === null
    const appUsername = createAppAccount ? 'ei_yeschef' : config.appUsername
    const resetExistingAccount = recovery && !createAppAccount
    const appPassword = randomBytes(32).toString('base64url')
    let appPasswordCiphertext: string
    try { appPasswordCiphertext = this.store.encrypt(appPassword) } catch {
      return { kind: 'error', message: 'Keychain 無法使用，未重設資料庫帳號密碼' }
    }
    try {
      await this.initializeDatabase(config, adminPassword, appUsername, appPassword, createAppAccount, resetExistingAccount)
      const next = resetExistingAccount
        ? { ...config, appUsername, appPasswordCiphertext }
        : { ...config, schemaVersion: SCHEMA_VERSION, appUsername, appPasswordCiphertext }
      await this.store.save(next)
      if (!resetExistingAccount) await this.cleanupInternal()
      return { kind: 'initialized', status: await this.status(await this.store.load()) }
    } catch (raw) { return this.initializationError(raw, config) }
  }

  private async initializeDatabase(
    config: StoredConfig, adminPassword: string, appUsername: string, appPassword: string,
    createAppAccount: boolean, resetExistingAccount: boolean,
  ): Promise<void> {
    await this.withPool(this.createPool(config, config.adminUsername, adminPassword, false), async (pool) => {
      if (resetExistingAccount) {
        await query(pool, 'ALTER USER ?@? IDENTIFIED BY ?', [appUsername, '%', appPassword])
        return
      }
      await assertAdminPermissions(pool, config.database)
      await selectDatabase(pool, config.database)
      for (const migration of MIGRATIONS) await query(pool, migration)
      if (await readSchemaVersion(pool) !== SCHEMA_VERSION) throw new Error('schema version mismatch')
      if (createAppAccount) {
        await ensureUser(pool, config.database, appUsername, appPassword, appAccountGrants)
        return
      }
      // 帳號已存在：重設密碼並補上這個資料庫的權限（資料庫名稱可能和建帳號當時不同）。GRANT 可重複執行，不動資料。
      await query(pool, 'ALTER USER ?@? IDENTIFIED BY ?', [appUsername, '%', appPassword])
      await grantTables(pool, config.database, appUsername, appAccountGrants)
    })
  }

  private initializationError(raw: unknown, config: StoredConfig): ErrorIntakeResponse {
    if (raw instanceof MissingPermissionsError) return { kind: 'error', message: `管理者帳號缺少必要權限：${raw.missing.join('、')}` }
    logDbError(this.deps.logError, '錯誤資料庫初始化失敗', raw)
    return { kind: 'error', message: connectionFailureMessage(raw, config) }
  }

  private async cleanupInternal(): Promise<ErrorIntakeCleanup | undefined> {
    const config = await this.readCleanupConfig()
    if (config === undefined || config.appPasswordCiphertext === null || config.schemaVersion !== SCHEMA_VERSION) return undefined
    // 密碼解不開時沒辦法清理，等使用者重新輸入密碼後下次啟動再清。
    if (this.ciphertextUnreadable(config.appPasswordCiphertext)) return undefined
    try {
      const password = this.store.decrypt(config.appPasswordCiphertext)
      const deleted = await this.withPool(this.createPool(config, config.appUsername, password), cleanRows)
      const result: ErrorIntakeCleanup = { ok: true, ...deleted, message: '清理完成' }
      await this.saveCleanupResult(config, result)
      return result
    } catch (raw) {
      logDbError(this.deps.logError, '錯誤資料庫清理失敗', raw)
      const deletedEvents = raw instanceof CleanupFailure ? raw.deletedEvents : 0
      const deletedGroups = raw instanceof CleanupFailure ? raw.deletedGroups : 0
      const result: ErrorIntakeCleanup = { ok: false, deletedEvents, deletedGroups, message: '清理失敗' }
      await this.saveCleanupResult(config, result)
      return result
    }
  }

  private async readCleanupConfig(): Promise<StoredConfig | undefined> {
    try { return await this.store.load() } catch { return undefined }
  }

  private async saveCleanupResult(config: StoredConfig, result: ErrorIntakeCleanup): Promise<void> {
    try { await this.store.save({ ...config, lastCleanupAt: this.now().toISOString(), lastCleanup: result }) } catch { /* store 已記錄安全錯誤 */ }
  }

  private async ensureProjectWriterInternal(projectId: string, projectCode: string): Promise<{ projectCode: string; username: string }> {
    validateProjectCode(projectId, projectCode)
    const config = await this.store.load()
    const existing = validateWriterOwnership(config, projectId, projectCode)
    const username = writerUsername(projectCode)
    // 已建立的帳號直接沿用：staging 與正式環境的設定裡存著這組密碼，重建會讓它們從此寫不進錯誤。
    if (existing !== undefined) return { projectCode, username }
    const password = randomBytes(32).toString('base64url')
    const passwordCiphertext = this.store.encrypt(password)
    await this.ensureWriterDatabaseAccount(config, username, password)
    await this.store.save({ ...config, projectWriters: replaceWriter(config, existing, projectId, projectCode, passwordCiphertext) })
    return { projectCode, username }
  }

  private async ensureWriterDatabaseAccount(config: StoredConfig, username: string, password: string): Promise<void> {
    if (config.schemaVersion !== SCHEMA_VERSION || config.adminPasswordCiphertext === null) throw new Error('請先初始化錯誤資料庫')
    const adminPassword = this.store.decrypt(config.adminPasswordCiphertext)
    try {
      await this.withPool(this.createPool(config, config.adminUsername, adminPassword, false), async (pool) => {
        await assertAdminPermissions(pool, config.database)
        await selectDatabase(pool, config.database)
        if (await readSchemaVersion(pool) !== SCHEMA_VERSION) throw new Error('schema version mismatch')
        await ensureUser(pool, config.database, username, password, writerGrants)
      })
    } catch (raw) {
      if (raw instanceof MissingPermissionsError) throw raw
      logDbError(this.deps.logError, '專案寫入帳號建立失敗', raw)
      throw new Error('專案寫入帳號建立失敗，請檢查錯誤資料庫設定')
    }
  }

  private async writerConnectionUrlInternal(projectId: string): Promise<string | undefined> {
    const config = await this.store.load()
    const writer = config.projectWriters.find((entry) => entry.projectId === projectId)
    if (writer === undefined) return undefined
    return buildWriterUrl(config, writer.projectCode, this.store.decrypt(writer.passwordCiphertext))
  }

  private async projectStateInternal(projectId: string, folderName: string) {
    const config = await this.store.load()
    const enabled = config.enabledProjects.find((entry) => entry.projectId === projectId)
    const writer = config.projectWriters.find((entry) => entry.projectId === projectId)
    const status = await this.status(config)
    return {
      defaultProjectCode: defaultProjectCode(folderName),
      enabled: enabled !== undefined,
      projectCode: enabled?.projectCode ?? writer?.projectCode ?? null,
      projectCodeLocked: writer !== undefined,
      databaseReady: status.connected && status.schemaVersion === SCHEMA_VERSION,
    }
  }

  private async markProjectEnabledInternal(projectId: string, projectCode: string, packageSource: string): Promise<void> {
    validateProjectCode(projectId, projectCode)
    const config = await this.store.load()
    const writer = config.projectWriters.find((entry) => entry.projectId === projectId)
    if (writer?.projectCode !== projectCode) throw new Error('專案寫入帳號尚未建立')
    const enabledProjects = config.enabledProjects.some((entry) => entry.projectId === projectId)
      ? config.enabledProjects.map((entry) => entry.projectId === projectId ? { ...entry, projectCode } : entry)
      : [...config.enabledProjects, { projectId, projectCode }]
    await this.store.save({ ...config, enabledProjects, packageSource: validatePackageSource(packageSource) })
  }

  private async rollbackProjectEnableInternal(projectId: string, packageSource: string): Promise<void> {
    const config = await this.store.load()
    await this.store.save({
      ...config,
      enabledProjects: config.enabledProjects.filter((entry) => entry.projectId !== projectId),
      packageSource,
    })
  }

  private async checkProjectErrorsInternal(projectId: string, projectCode: string, sinceMinutes: number): Promise<readonly ErrorIntakeGroup[]> {
    if (!Number.isInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 120) throw new Error('sinceMinutes 須為 1 到 120')
    const config = await this.store.load()
    const enabled = config.enabledProjects.find((entry) => entry.projectId === projectId)
    if (enabled?.projectCode !== projectCode) throw new Error('這個專案尚未啟用錯誤收集')
    if (config.schemaVersion !== SCHEMA_VERSION || config.appPasswordCiphertext === null) throw new Error('錯誤資料庫尚未初始化或版本不正確')
    try {
      const password = this.store.decrypt(config.appPasswordCiphertext)
      return await this.withPool(this.createPool(config, config.appUsername, password), async (pool) => {
        if (await readSchemaVersion(pool) !== SCHEMA_VERSION) throw new Error('schema version mismatch')
        const [rows] = await query(pool,
          'SELECT source, error_type, route, environment FROM error_group WHERE project = ? AND last_seen_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE) ORDER BY last_seen_at DESC',
          [projectCode, sinceMinutes])
        return errorGroups(rows)
      })
    } catch (raw) {
      logDbError(this.deps.logError, '錯誤收集查詢失敗', raw)
      throw new Error('錯誤資料庫無法查詢，請確認資料庫設定')
    }
  }
}

const appAccountGrants = [
  { table: 'error_group', privileges: 'SELECT, UPDATE, DELETE' },
  { table: 'error_event', privileges: 'SELECT, UPDATE, DELETE' },
  { table: 'error_intake_meta', privileges: 'SELECT' },
] as const

const writerGrants = [
  { table: 'error_group', privileges: 'SELECT, INSERT, UPDATE' },
  { table: 'error_event', privileges: 'SELECT, INSERT, DELETE' },
  { table: 'error_intake_meta', privileges: 'SELECT' },
] as const
