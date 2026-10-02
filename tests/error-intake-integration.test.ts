import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPool } from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { createErrorIntakeService, writerUsername } from '../src/main/error-intake/service.js'
import { createErrorIntakeActivation } from '../src/main/error-intake/activation.js'
import type { ChefService } from '../src/main/chef/service.js'
import type { ErrorIntakeService } from '../src/main/error-intake/service.js'
import type { SafeStorageLike } from '../src/main/error-intake/store.js'

const rootUrl = process.env['YESCHEF_ERROR_DB_TEST_URL']
const integration = rootUrl === undefined || rootUrl === '' ? describe.skip : describe
const temporaryDirs: string[] = []

interface Fixture {
  readonly root: URL
  readonly rootPool: ReturnType<typeof createPool>
  readonly databaseName: string
  readonly writerCode: string
  readonly writerId: string
  readonly writerUser: string
  readonly host: string
  readonly port: number
  readonly service: ErrorIntakeService
  databaseCreated: boolean
  testPool?: ReturnType<typeof createPool>
  writerPool?: ReturnType<typeof createPool>
}

afterAll(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

integration('錯誤資料庫 MySQL 整合', () => {
  it('初始化 schema、限制寫入帳號並清理過期資料', async () => {
    if (rootUrl !== undefined) await runIntegration(rootUrl)
  }, 60_000)
})

async function runIntegration(url: string): Promise<void> {
  const fixture = await createFixture(url)
  try {
    await prepareDatabase(fixture)
    const writerPool = await createWriterPool(fixture)
    await testWriterRestrictions(fixture, writerPool)
    await testCheckErrorIntake(fixture)
    await testCleanup(fixture)
  } finally {
    await cleanupFixture(fixture)
  }
}

async function testCheckErrorIntake(fixture: Fixture): Promise<void> {
  const chef = {
    handle: async () => ({ kind: 'state', state: { models: [{ key: 'model-a' }] } }),
    start: async () => 'setup-task',
  } as unknown as ChefService
  const activation = createErrorIntakeActivation({
    service: fixture.service, chef, rootPathOf: () => '/tmp/error-intake-integration', writeClipboard: () => {},
  })
  const enabled = await activation.handle({
    action: 'enable', projectId: fixture.writerId, projectCode: fixture.writerCode,
    acknowledged: true, packageSource: '@yeschef/error-intake',
  })
  expect(enabled).toMatchObject({ kind: 'enabled', projectCode: fixture.writerCode })
  const groups = await fixture.service.checkProjectErrors(fixture.writerId, fixture.writerCode, 120)
  expect(groups).toEqual([{ source: 'server', error_type: 'Error', route: null, environment: 'local' }])
  await testProjectScopedPull(fixture)
}

async function testProjectScopedPull(fixture: Fixture): Promise<void> {
  const ownGroup = '01J8T3W9T1H7M4X6K2V5P0QPA1'
  const otherGroup = '01J8T3W9T1H7M4X6K2V5P0QPA2'
  await insertPullGroup(fixture.testPool!, ownGroup, fixture.writerCode)
  await insertPullGroup(fixture.testPool!, otherGroup, `other-${fixture.writerCode}`)
  const listed = await fixture.service.listPullErrors(fixture.writerId, 'production')
  expect(listed.newGroups.map(group => group.id)).toContain(ownGroup)
  expect(listed.newGroups.map(group => group.id)).not.toContain(otherGroup)
  await expect(fixture.service.updateGroupStatus(fixture.writerId, otherGroup, 'resolved')).rejects.toThrow('找不到')
  const [ownRows] = await fixture.testPool!.query('SELECT status FROM error_group WHERE id = ?', [ownGroup])
  const [otherRows] = await fixture.testPool!.query('SELECT status FROM error_group WHERE id = ?', [otherGroup])
  expect(ownRows).toEqual([{ status: 'new' }])
  expect(otherRows).toEqual([{ status: 'new' }])
  await fixture.service.updateGroupStatus(fixture.writerId, ownGroup, 'resolved')
  const [resolvedRows] = await fixture.testPool!.query('SELECT status, resolved_at FROM error_group WHERE id = ?', [ownGroup])
  expect(resolvedRows).toMatchObject([{ status: 'resolved', resolved_at: expect.anything() }])
}

async function insertPullGroup(pool: ReturnType<typeof createPool>, id: string, project: string): Promise<void> {
  const at = mysqlDate(new Date())
  await pool.query(`INSERT INTO error_group
    (id, project, environment, fingerprint, source, error_type, message, top_frame, count, first_seen_at, last_seen_at, status)
    VALUES (?, ?, 'production', ?, 'server', 'TypeError', 'pull sample', 'src', 1, ?, ?, 'new')`,
  [id, project, randomBytes(32).toString('hex'), at, at])
  await pool.query('INSERT INTO error_event (id, group_id, occurred_at, message, stack) VALUES (?, ?, ?, ?, ?)',
    [randomBytes(13).toString('hex').slice(0, 26), id, at, 'pull sample', 'at app (src/app.ts:1)'])
}

async function createFixture(url: string): Promise<Fixture> {
  const root = new URL(url)
  const suffix = randomBytes(6).toString('hex')
  const dir = await mkdtemp(join(tmpdir(), 'yeschef-error-intake-'))
  temporaryDirs.push(dir)
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  }
  return {
    root,
    rootPool: createPool({ uri: url, connectionLimit: 1 }),
    databaseName: `yeschef_ei_${suffix}`,
    writerCode: `p${suffix}`,
    writerId: `integration-${suffix}`,
    writerUser: writerUsername(`p${suffix}`),
    host: root.hostname.replace(/^\[|\]$/g, ''),
    port: Number(root.port || 3306),
    service: createErrorIntakeService({ dir, safeStorage, logError: () => {} }),
    databaseCreated: false,
  }
}

async function prepareDatabase(fixture: Fixture): Promise<void> {
  await fixture.rootPool.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [fixture.databaseName])
  fixture.databaseCreated = true
  fixture.testPool = createTestPool(fixture)
  await fixture.testPool.query('CREATE TABLE writer_private (value INT NOT NULL)')
  const saved = await fixture.service.handle({ action: 'save', settings: adminSettings(fixture) })
  expect(saved.kind).toBe('settings')
  const initialized = await fixture.service.handle({ action: 'initialize' })
  expect(initialized).toMatchObject({ kind: 'initialized', status: { connected: true, passwordNeedsReentry: false, schemaVersion: 1 } })
}

function adminSettings(fixture: Fixture) {
  return {
    host: fixture.host,
    port: fixture.port,
    database: fixture.databaseName,
    tls: false,
    adminUsername: decodeURIComponent(fixture.root.username),
    adminPassword: decodeURIComponent(fixture.root.password),
  }
}

function createTestPool(fixture: Fixture): ReturnType<typeof createPool> {
  return createPool({
    host: fixture.host,
    port: fixture.port,
    user: decodeURIComponent(fixture.root.username),
    password: decodeURIComponent(fixture.root.password),
    database: fixture.databaseName,
    connectionLimit: 1,
  })
}

async function createWriterPool(fixture: Fixture): Promise<ReturnType<typeof createPool>> {
  await fixture.service.ensureProjectWriter(fixture.writerId, fixture.writerCode)
  const url = await fixture.service.writerConnectionUrl(fixture.writerId)
  expect(url).toBeDefined()
  const pool = createPool({ uri: url!, connectionLimit: 1 })
  fixture.writerPool = pool
  return pool
}

async function testWriterRestrictions(fixture: Fixture, pool: ReturnType<typeof createPool>): Promise<void> {
  await writeSample(pool, '01J8T3W9T1H7M4X6K2V5P0QABC', fixture.writerCode, new Date())
  await expect(pool.query('SELECT * FROM writer_private')).rejects.toBeDefined()
  await expect(pool.query('INSERT INTO writer_private (value) VALUES (1)')).rejects.toBeDefined()
  await expect(pool.query('CREATE TABLE writer_cannot_create (value INT)')).rejects.toBeDefined()
  await expect(pool.query('INSERT INTO error_intake_meta (id, schema_version) VALUES (2, 1)')).rejects.toBeDefined()
}

async function testCleanup(fixture: Fixture): Promise<void> {
  const pool = fixture.testPool!
  const oldAt = mysqlDate(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000))
  const oldGroup = '01J8T3W9T1H7M4X6K2V5P0QABD'
  await insertOldGroup(pool, oldGroup, fixture.writerCode, oldAt)
  const cleanup = await fixture.service.runCleanup()
  expect(cleanup).toMatchObject({ ok: true, deletedEvents: 1, deletedGroups: 1 })
  const [rows] = await pool.query('SELECT id FROM error_group WHERE id = ?', [oldGroup])
  expect(rows).toEqual([])
}

async function insertOldGroup(pool: ReturnType<typeof createPool>, groupId: string, project: string, oldAt: string): Promise<void> {
  await pool.query(`INSERT INTO error_group
    (id, project, environment, fingerprint, source, error_type, message, top_frame, count, first_seen_at, last_seen_at, status)
    VALUES (?, ?, 'local', ?, 'server', 'Error', 'old sample', 'src', 1, ?, ?, 'ignored')`,
  [groupId, project, 'a'.repeat(64), oldAt, oldAt])
  await pool.query('INSERT INTO error_event (id, group_id, occurred_at, message, stack) VALUES (?, ?, ?, ?, ?)',
    ['01J8T3W9T1H7M4X6K2V5P0QABE', groupId, oldAt, 'old sample', 'stack'])
}

async function writeSample(pool: ReturnType<typeof createPool>, groupId: string, project: string, date: Date): Promise<void> {
  const eventId = '01J8T3W9T1H7M4X6K2V5P0QABF'
  const [result] = await pool.query(`INSERT INTO error_group
    (id, project, environment, fingerprint, source, error_type, message, top_frame, count, first_seen_at, last_seen_at, status)
    VALUES (?, ?, 'local', ?, 'server', 'Error', 'sample', 'src', 1, ?, ?, 'new')`, [groupId, project, 'b'.repeat(64), date, date])
  expect(result).toBeDefined()
  await pool.query('INSERT INTO error_event (id, group_id, occurred_at, message, stack) VALUES (?, ?, ?, ?, ?)', [eventId, groupId, date, 'sample', 'stack'])
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.writerPool?.end().catch(() => {})
  await fixture.testPool?.end().catch(() => {})
  await fixture.rootPool.query('DROP USER IF EXISTS ?@?', [fixture.writerUser, '%']).catch(() => {})
  await fixture.rootPool.query('DROP USER IF EXISTS ?@?', ['ei_yeschef', '%']).catch(() => {})
  if (fixture.databaseCreated) await fixture.rootPool.query('DROP DATABASE ??', [fixture.databaseName]).catch(() => {})
  await fixture.rootPool.end()
}

function mysqlDate(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ')
}
