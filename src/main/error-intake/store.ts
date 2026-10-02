import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ERROR_INTAKE_PACKAGE_SOURCE, type ErrorIntakeCleanup } from '../../shared/error-intake.js'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

const WriterSchema = z.preprocess(withLegacyProjectId, z.object({
  projectId: z.string().min(1),
  projectCode: z.string().regex(/^[a-z0-9-]{1,28}$/),
  passwordCiphertext: z.string().min(1),
}).strict())

const EnabledProjectSchema = z.preprocess(withLegacyProjectId, z.object({
  projectId: z.string().min(1),
  projectCode: z.string().regex(/^[a-z0-9-]{1,28}$/),
}).strict())

const StoredConfigSchema = z.preprocess(withLegacyConfigFields, z.object({
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  tls: z.boolean(),
  adminUsername: z.string(),
  adminPasswordCiphertext: z.string().nullable(),
  appPasswordCiphertext: z.string().nullable().default(null),
  appUsername: z.string().min(1).max(32).default('ei_sidepane'),
  schemaVersion: z.number().int().nullable(),
  projectWriters: z.array(WriterSchema),
  enabledProjects: z.array(EnabledProjectSchema).default([]),
  packageSource: z.string().trim().min(1).max(1024).default(ERROR_INTAKE_PACKAGE_SOURCE),
  lastCleanupAt: z.string().nullable(),
  lastCleanup: z.object({
    ok: z.boolean(),
    deletedEvents: z.number().int().nonnegative(),
    deletedGroups: z.number().int().nonnegative(),
    message: z.string(),
  }).strict().nullable(),
}).strict())

export type StoredConfig = z.infer<typeof StoredConfigSchema>
export type StoredWriter = z.infer<typeof WriterSchema>
export type StoredEnabledProject = z.infer<typeof EnabledProjectSchema>

export const EMPTY_CONFIG: StoredConfig = {
  host: '', port: 3306, database: '', tls: true, adminUsername: '',
  adminPasswordCiphertext: null, appPasswordCiphertext: null, appUsername: 'ei_yeschef', schemaVersion: null,
  projectWriters: [], enabledProjects: [], packageSource: ERROR_INTAKE_PACKAGE_SOURCE,
  lastCleanupAt: null, lastCleanup: null,
}

function withLegacyProjectId(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { sidepaneProjectId, ...current } = value
  return { ...current, projectId: Object.hasOwn(value, 'projectId') ? value.projectId : sidepaneProjectId }
}

function withLegacyConfigFields(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { sidepanePasswordCiphertext, appPasswordCiphertext, projectWriters, enabledProjects, ...current } = value
  return {
    ...current,
    appPasswordCiphertext: Object.hasOwn(value, 'appPasswordCiphertext')
      ? value.appPasswordCiphertext
      : sidepanePasswordCiphertext,
    appUsername: Object.hasOwn(value, 'appUsername') ? value.appUsername : 'ei_sidepane',
    projectWriters: Array.isArray(projectWriters) ? projectWriters.map(withLegacyProjectId) : projectWriters,
    enabledProjects: Array.isArray(enabledProjects) ? enabledProjects.map(withLegacyProjectId) : enabledProjects,
    ...(typeof value.packageSource === 'string' ? { packageSource: withLegacyPackageSource(value.packageSource) } : {}),
  }
}

/** 改名前的預設套件名稱，以及搬到 `~/.yeschef` 前放打包檔的 `~/.sidepane`。 */
const LEGACY_PACKAGE_NAME = '@sidepane/error-intake'
const LEGACY_HOME_DIR = /\/\.sidepane\//

function withLegacyPackageSource(source: string): string {
  if (source.trim() === LEGACY_PACKAGE_NAME) return ERROR_INTAKE_PACKAGE_SOURCE
  return source.replace(LEGACY_HOME_DIR, '/.yeschef/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ErrorIntakeStore {
  load(): Promise<StoredConfig>
  save(config: StoredConfig): Promise<void>
  encrypt(plain: string): string
  decrypt(ciphertext: string): string
}

export function createErrorIntakeStore(deps: {
  readonly dir: string
  readonly safeStorage: SafeStorageLike
  readonly logError: (error: Error) => void
}): ErrorIntakeStore {
  const path = join(deps.dir, 'error-intake.json')

  const load = async (): Promise<StoredConfig> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (raw) {
      if ((raw as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_CONFIG
      deps.logError(new Error('錯誤收集資料庫設定檔讀取失敗'))
      throw new Error('設定檔讀取失敗')
    }
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    const parsed = StoredConfigSchema.safeParse(json)
    if (!parsed.success) {
      deps.logError(new Error('錯誤收集資料庫設定檔格式錯誤'))
      throw new Error('設定檔格式錯誤')
    }
    return parsed.data
  }

  const save = async (config: StoredConfig): Promise<void> => {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
      await rename(temp, path)
    } catch (raw) {
      await rm(temp, { force: true }).catch(() => {})
      deps.logError(new Error('錯誤收集資料庫設定檔儲存失敗'))
      throw new Error('設定檔儲存失敗')
    }
  }

  return {
    load,
    save,
    encrypt: (plain) => {
      if (!deps.safeStorage.isEncryptionAvailable()) throw new Error('Keychain 不可用')
      try { return deps.safeStorage.encryptString(plain).toString('base64') } catch { throw new Error('密碼加密失敗') }
    },
    decrypt: (ciphertext) => {
      try { return deps.safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) } catch { throw new Error('密碼密文無法解密') }
    },
  }
}
