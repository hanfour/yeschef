import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createErrorIntakeStore, EMPTY_CONFIG, type SafeStorageLike } from '../src/main/error-intake/store.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'error-intake-store-'))
  directories.push(dir)
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: value => value.toString().replace(/^enc:/, ''),
  }
  return { dir, store: createErrorIntakeStore({ dir, safeStorage, logError: vi.fn() }) }
}

it('讀取舊 JSON 欄位並在下次保存時只寫新欄位', async () => {
  const { dir, store } = await makeStore()
  const old = {
    ...EMPTY_CONFIG,
    adminPasswordCiphertext: 'enc:admin',
    sidepanePasswordCiphertext: 'enc:app',
    projectWriters: [{ sidepaneProjectId: 'project-1', projectCode: 'orders', passwordCiphertext: 'enc:writer' }],
    enabledProjects: [{ sidepaneProjectId: 'project-1', projectCode: 'orders' }],
  }
  const { appPasswordCiphertext: _appPassword, appUsername: _appUsername, ...legacy } = old
  await writeFile(join(dir, 'error-intake.json'), JSON.stringify(legacy))

  const loaded = await store.load()
  expect(loaded).toMatchObject({
    appPasswordCiphertext: 'enc:app', appUsername: 'ei_sidepane',
    projectWriters: [{ projectId: 'project-1', projectCode: 'orders' }],
    enabledProjects: [{ projectId: 'project-1', projectCode: 'orders' }],
  })
  await store.save(loaded)
  const saved = await readFile(join(dir, 'error-intake.json'), 'utf8')
  expect(saved).toContain('"appPasswordCiphertext"')
  expect(saved).toContain('"appUsername": "ei_sidepane"')
  expect(saved).toContain('"projectId": "project-1"')
  expect(saved).not.toContain('sidepanePasswordCiphertext')
  expect(saved).not.toContain('sidepaneProjectId')
})

it('同時有新舊欄位時優先讀新名稱', async () => {
  const { dir, store } = await makeStore()
  await writeFile(join(dir, 'error-intake.json'), JSON.stringify({
    ...EMPTY_CONFIG,
    appPasswordCiphertext: 'enc:new-app', sidepanePasswordCiphertext: 'enc:old-app',
    appUsername: 'ei_yeschef',
    projectWriters: [{ projectId: 'new-project', sidepaneProjectId: 'old-project', projectCode: 'orders', passwordCiphertext: 'enc:writer' }],
  }))
  await expect(store.load()).resolves.toMatchObject({
    appPasswordCiphertext: 'enc:new-app', appUsername: 'ei_yeschef',
    projectWriters: [{ projectId: 'new-project' }],
  })
})

it('舊的套件來源對應到新名稱與搬移後的打包檔路徑', async () => {
  const { dir, store } = await makeStore()
  const path = join(dir, 'error-intake.json')
  // 改名前存下的預設值；不轉換的話新版的存檔檢查會拒絕，連重新輸入密碼都存不進去。
  await writeFile(path, JSON.stringify({ ...EMPTY_CONFIG, packageSource: '@sidepane/error-intake' }))
  await expect(store.load()).resolves.toMatchObject({ packageSource: '@yeschef/error-intake' })

  await writeFile(path, JSON.stringify({ ...EMPTY_CONFIG, packageSource: '/Users/me/.sidepane/packages/sidepane-error-intake-0.1.0.tgz' }))
  await expect(store.load()).resolves.toMatchObject({ packageSource: '/Users/me/.yeschef/packages/sidepane-error-intake-0.1.0.tgz' })

  await writeFile(path, JSON.stringify({ ...EMPTY_CONFIG, packageSource: '/opt/pkgs/custom.tgz' }))
  await expect(store.load()).resolves.toMatchObject({ packageSource: '/opt/pkgs/custom.tgz' })
})
