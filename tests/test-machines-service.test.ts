/**
 * I6:save() 寫檔失敗時的暫存檔清理(`rm(tmp, { force: true })`)本身也可能失敗;
 * 這裡只覆寫 rename 與「清 .tmp 檔」這兩個動作,其他呼叫(mkdtemp、afterEach 的整目錄
 * 清理、service.ts 的 removeProject)原樣走真正的 fs,不受影響。
 */
const fsOverrides: { renameFail?: Error; rmTmpFail?: Error } = {}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsOverrides.renameFail !== undefined) throw fsOverrides.renameFail
      return actual.rename(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = args[0]
      if (fsOverrides.rmTmpFail !== undefined && typeof target === 'string' && target.endsWith('.tmp')) throw fsOverrides.rmTmpFail
      return actual.rm(...args)
    },
  }
})

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestMachinesService, type SafeStorageLike, type TestMachinesService } from '../src/main/test-machines/service.js'
import { MSG } from '../src/main/view-tools/errors.js'

/** 假的加密:反轉字串再加前綴,足以分辨「存的是密文」與「解回明文」。 */
function fakeSafeStorage(available = true): SafeStorageLike & { available: boolean } {
  const box = {
    available,
    isEncryptionAvailable: () => box.available,
    encryptString: (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString()
      if (!text.startsWith('enc:')) throw new Error('bad cipher')
      return [...text.slice(4)].reverse().join('')
    },
  }
  return box
}

let dir: string
let safe: ReturnType<typeof fakeSafeStorage>
let logError: ReturnType<typeof vi.fn<(error: Error) => void>>
let service: TestMachinesService
const MACHINE = { name: 'staging', url: 'https://staging.test/login', username: 'qa', password: 's3cret' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-'))
  safe = fakeSafeStorage()
  logError = vi.fn()
  let n = 0
  service = createTestMachinesService({ dir, safeStorage: safe, logError, newId: () => `id-${++n}` })
})
afterEach(async () => {
  fsOverrides.renameFail = undefined
  fsOverrides.rmTmpFail = undefined
  await rm(dir, { recursive: true, force: true })
})

async function upsert(machine: object, revision = 0, projectId = 'p1') {
  return service.handle({ action: 'upsert', projectId, revision, machine })
}

describe('list 與 upsert', () => {
  it('空專案回空清單,revision 0', async () => {
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'state', revision: 0, machines: [] })
  })

  it('存一筆:回應沒有 password 欄位,檔案裡是密文不是明文', async () => {
    const res = await upsert(MACHINE)
    expect(res).toEqual({ kind: 'state', revision: 1, machines: [{ id: 'id-1', name: 'staging', url: MACHINE.url, username: 'qa', hasPassword: true, passwordNeedsReentry: false }] })
    const raw = await readFile(join(dir, 'p1.json'), 'utf8')
    expect(raw).not.toContain('s3cret')
    expect(raw).toContain(Buffer.from('enc:terc3s').toString('base64'))
    expect((await stat(join(dir, 'p1.json'))).mode & 0o777).toBe(0o600)
  })

  it('credentialsFor 解回明文與 origin', async () => {
    await upsert(MACHINE)
    await expect(service.credentialsFor('p1', 'staging')).resolves.toEqual({ username: 'qa', password: 's3cret', passwordUnreadable: false, origin: 'https://staging.test' })
    await expect(service.credentialsFor('p1', 'nope')).resolves.toBeUndefined()
    await expect(service.credentialsFor('p2', 'staging')).resolves.toBeUndefined()
  })

  it('編輯時不帶 password 保留原密文', async () => {
    await upsert(MACHINE)
    const res = await upsert({ id: 'id-1', name: 'staging2', url: MACHINE.url, username: 'qa2' }, 1)
    expect(res).toMatchObject({ kind: 'state', revision: 2, machines: [{ id: 'id-1', name: 'staging2', username: 'qa2', hasPassword: true }] })
    await expect(service.credentialsFor('p1', 'staging2')).resolves.toMatchObject({ password: 's3cret', passwordUnreadable: false })
  })

  it('把測試機改名成它自己原本的名字要成功', async () => {
    await upsert(MACHINE)
    const res = await upsert({ id: 'id-1', name: 'staging', url: MACHINE.url, username: 'qa2' }, 1)
    expect(res).toMatchObject({ kind: 'state', revision: 2 })
  })

  it('同一個專案的兩個 upsert 同時來,依序套用,兩筆都在', async () => {
    const [, second] = await Promise.all([
      upsert({ name: 'a', url: 'https://a.test/', username: 'ua' }, 0),
      upsert({ name: 'b', url: 'https://b.test/', username: 'ub' }, 1),
    ])
    expect(second).toMatchObject({ kind: 'state', revision: 2, machines: [{ name: 'a' }, { name: 'b' }] })
  })

  it('沒設密碼:hasPassword false,credentialsFor 的 password 是 null', async () => {
    await upsert({ name: 'nopw', url: 'https://a.test/', username: 'u' })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ machines: [{ hasPassword: false, passwordNeedsReentry: false }] })
    await expect(service.credentialsFor('p1', 'nopw')).resolves.toEqual({ username: 'u', password: null, passwordUnreadable: false, origin: 'https://a.test' })
  })

  it('同一個專案內名字不能重複', async () => {
    await upsert(MACHINE)
    await expect(upsert({ ...MACHINE }, 1)).resolves.toEqual({ kind: 'error', message: '已經有叫 staging 的測試機' })
  })

  it('revision 對不上被拒,狀態不變', async () => {
    await upsert(MACHINE)
    await expect(upsert({ ...MACHINE, name: 'other' }, 0)).resolves.toEqual({ kind: 'error', message: '設定已被更動,請重新載入後再試' })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ revision: 1 })
  })

  it('鑰匙圈不可用:帶密碼的 upsert 被拒,不帶密碼的照常', async () => {
    safe.available = false
    await expect(upsert(MACHINE)).resolves.toEqual({ kind: 'error', message: MSG.keychainUnavailable })
    await expect(upsert({ name: 'nopw', url: 'https://a.test/', username: 'u' })).resolves.toMatchObject({ kind: 'state', revision: 1 })
  })

  it('remove 刪一筆;removeProject 刪整個檔', async () => {
    await upsert(MACHINE)
    await expect(service.handle({ action: 'remove', projectId: 'p1', revision: 1, id: 'id-1' })).resolves.toEqual({ kind: 'state', revision: 2, machines: [] })
    await service.removeProject('p1')
    await expect(stat(join(dir, 'p1.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'state', revision: 0, machines: [] })
  })

  it('請求格式不對回 error,不丟例外', async () => {
    await expect(service.handle({ action: 'list' })).resolves.toMatchObject({ kind: 'error' })
    await expect(service.handle(null)).resolves.toMatchObject({ kind: 'error' })
  })

  it('加密失敗:upsert 回 error,檔案不變', async () => {
    await upsert(MACHINE)
    const before = await readFile(join(dir, 'p1.json'), 'utf8')
    safe.encryptString = () => { throw new Error('keychain locked') }
    await expect(upsert({ ...MACHINE, name: 'other', password: 'x' }, 1)).resolves.toEqual({ kind: 'error', message: '測試機設定儲存失敗,請檢查主程序紀錄' })
    expect(await readFile(join(dir, 'p1.json'), 'utf8')).toBe(before)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('rename 與清理暫存檔都失敗:logError 收到 rename 的原始錯誤,不是清理失敗的錯誤蓋掉(I6)', async () => {
    fsOverrides.renameFail = new Error('rename 壞了')
    fsOverrides.rmTmpFail = new Error('rm 也壞了')
    await expect(upsert(MACHINE)).resolves.toEqual({ kind: 'error', message: '測試機設定儲存失敗,請檢查主程序紀錄' })
    expect(logError).toHaveBeenCalledTimes(1)
    const [error] = logError.mock.calls[0] as [Error]
    expect(error.message).toBe('rename 壞了')
  })
})

describe('壞掉的檔案與密文', () => {
  it('檔案損毀:list 回 error,不清空、不覆寫', async () => {
    await writeFile(join(dir, 'p1.json'), '{not json', { mode: 0o600 })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'error', message: '測試機設定檔無法讀取,請檢查主程序紀錄' })
    expect(await readFile(join(dir, 'p1.json'), 'utf8')).toBe('{not json')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('密文解不開時標示需要重輸並可保存新密碼', async () => {
    await upsert(MACHINE)
    const path = join(dir, 'p1.json')
    const before = JSON.parse(await readFile(path, 'utf8')) as { machines: { password: string }[] }
    const garbage = Buffer.from('garbage').toString('base64')
    const stored = { ...before, machines: [{ ...before.machines[0]!, password: garbage }] }
    await writeFile(path, JSON.stringify(stored))
    const fresh = createTestMachinesService({ dir, safeStorage: safe, logError })

    await expect(fresh.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ machines: [{ hasPassword: false, passwordNeedsReentry: true }] })
    await expect(fresh.credentialsFor('p1', 'staging')).resolves.toMatchObject({ password: null, passwordUnreadable: true })
    expect(logError).toHaveBeenCalledTimes(1)

    await expect(fresh.handle({ action: 'upsert', projectId: 'p1', revision: 1, machine: { id: 'id-1', ...MACHINE, password: undefined } }))
      .resolves.toEqual({ kind: 'error', message: '請重新輸入這台測試機的密碼' })
    await fresh.handle({ action: 'upsert', projectId: 'p1', revision: 1, machine: { id: 'id-1', ...MACHINE, password: 'new-secret' } })
    const after = JSON.parse(await readFile(path, 'utf8')) as { machines: { name: string; password: string | null }[] }
    expect(after.machines.find((m) => m.name === 'staging')?.password).not.toBe(garbage)
    await expect(fresh.credentialsFor('p1', 'staging')).resolves.toMatchObject({ password: 'new-secret', passwordUnreadable: false })
  })

  it('存檔裡的網址壞掉:list 回 error,credentialsFor 回 undefined,不丟例外', async () => {
    const path = join(dir, 'p1.json')
    await writeFile(path, JSON.stringify({ revision: 1, machines: [{ id: 'id-1', name: 'staging', url: 'not a url', username: 'qa', password: null }] }))
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ kind: 'error' })
    await expect(service.credentialsFor('p1', 'staging')).resolves.toBeUndefined()
  })
})
