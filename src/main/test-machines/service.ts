import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { TestMachinesRequestSchema, nameSchema, urlSchema, type MachineInput, type MachineView, type TestMachinesResponse } from '../../shared/test-machines.js'
import { MSG } from '../view-tools/errors.js'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

export interface Credentials {
  readonly username: string
  /** null:沒設密碼,或密文解不開(換了 build 或金鑰)。 */
  readonly password: string | null
  /** true:有存密文,但解不開(換了 build 或金鑰);password 因此是 null。 */
  readonly passwordUnreadable: boolean
  readonly origin: string
}

export interface TestMachinesService {
  handle(raw: unknown): Promise<TestMachinesResponse>
  /** 只給主行程用;renderer 拿不到這個。 */
  credentialsFor(projectId: string, name: string): Promise<Credentials | undefined>
  removeProject(projectId: string): Promise<void>
}

export interface TestMachinesDeps {
  readonly dir: string
  readonly safeStorage: SafeStorageLike
  readonly logError: (error: Error) => void
  readonly newId?: () => string
}

const StoredMachineSchema = z.object({
  id: z.string().min(1), name: nameSchema, url: urlSchema, username: z.string(),
  /** safeStorage.encryptString() 的密文,base64。 */
  password: z.string().nullable(),
})
const StoredFileSchema = z.object({ revision: z.number().int().nonnegative(), machines: z.array(StoredMachineSchema) })
type StoredFile = z.infer<typeof StoredFileSchema>
type StoredMachine = z.infer<typeof StoredMachineSchema>

const EMPTY: StoredFile = { revision: 0, machines: [] }
const TEXT = {
  unreadable: '測試機設定檔無法讀取,請檢查主程序紀錄',
  stale: '設定已被更動,請重新載入後再試',
  duplicate: (name: string) => `已經有叫 ${name} 的測試機`,
  notFound: '找不到這筆測試機',
  badRequest: '測試機請求格式不對',
  saveFailed: '測試機設定儲存失敗,請檢查主程序紀錄',
  passwordReentry: '請重新輸入這台測試機的密碼',
} as const

const error = (message: string): TestMachinesResponse => ({ kind: 'error', message })

export function createTestMachinesService(deps: TestMachinesDeps): TestMachinesService {
  const newId = deps.newId ?? randomUUID
  const pathOf = (projectId: string): string => join(deps.dir, `${projectId}.json`)
  /** 每個專案一條寫入佇列,同專案的寫入依序,不同專案互不等待。 */
  let queues: ReadonlyMap<string, Promise<void>> = new Map()

  /** 只有 credentialsFor 會呼叫:密文解不開就記一次錯,回 null,絕不把原始密文或明文寫進錯誤訊息。 */
  const decrypt = (cipher: string, reportFailure = true): string | null => {
    try {
      return deps.safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (raw) {
      if (reportFailure) deps.logError(new Error('測試機的密碼密文解不開,請重新設定密碼', { cause: raw }))
      return null
    }
  }

  /** 只讀檔、驗證格式,不解密、不改動任何欄位——密文解不開是暫時的(例如鑰匙圈剛好鎖住),
   *  不能因為讀了一次就被別筆機器的寫入連帶清掉。 */
  const load = async (projectId: string): Promise<StoredFile | 'unreadable'> => {
    let text: string
    try {
      text = await readFile(pathOf(projectId), 'utf8')
    } catch (raw) {
      if ((raw as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
      deps.logError(raw instanceof Error ? raw : new Error(String(raw)))
      return 'unreadable'
    }
    const parsed = StoredFileSchema.safeParse(safeJson(text))
    if (!parsed.success) {
      deps.logError(new Error(`測試機設定檔格式不對:${pathOf(projectId)}`))
      return 'unreadable'
    }
    return parsed.data
  }

  const save = async (projectId: string, file: StoredFile): Promise<void> => {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 })
    const path = pathOf(projectId)
    const tmp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
      await rename(tmp, path)
    } catch (raw) {
      // 清暫存檔本身也可能失敗(例如磁碟已經滿了);往上丟的一定是原本寫檔失敗的
      // 那個錯誤,不能被這裡的清理錯誤蓋掉(I6)。
      await rm(tmp, { force: true }).catch(() => {})
      throw raw
    }
  }

  /** 同一個專案的讀改寫串在一條佇列上,兩個 upsert 同時來不會互相蓋掉。 */
  const withProject = <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(projectId) ?? Promise.resolve()
    const task = previous.then(work, work)
    queues = new Map([...queues, [projectId, task.then(() => {}, () => {})]])
    return task
  }

  const toView = (m: StoredMachine): MachineView => {
    const passwordNeedsReentry = m.password !== null && decrypt(m.password, false) === null
    return {
      id: m.id, name: m.name, url: m.url, username: m.username,
      hasPassword: m.password !== null && !passwordNeedsReentry, passwordNeedsReentry,
    }
  }
  const state = (file: StoredFile): TestMachinesResponse => ({ kind: 'state', revision: file.revision, machines: file.machines.map(toView) })

  const applyUpsert = (file: StoredFile, input: MachineInput): StoredFile | TestMachinesResponse => {
    const existing = file.machines.find((m) => m.id === input.id)
    if (file.machines.some((m) => m.name === input.name && m !== existing)) return error(TEXT.duplicate(input.name))
    if (input.password === undefined && existing !== undefined && existing.password !== null && decrypt(existing.password, false) === null) {
      return error(TEXT.passwordReentry)
    }
    if (input.password !== undefined && !deps.safeStorage.isEncryptionAvailable()) return error(MSG.keychainUnavailable)
    const password = input.password === undefined
      ? existing?.password ?? null
      : deps.safeStorage.encryptString(input.password).toString('base64')
    const next: StoredMachine = { id: existing?.id ?? newId(), name: input.name, url: input.url, username: input.username, password }
    const machines = existing === undefined ? [...file.machines, next] : file.machines.map((m) => (m === existing ? next : m))
    return { revision: file.revision + 1, machines }
  }

  const mutate = (projectId: string, revision: number, change: (file: StoredFile) => StoredFile | TestMachinesResponse): Promise<TestMachinesResponse> =>
    withProject(projectId, async () => {
      const file = await load(projectId)
      if (file === 'unreadable') return error(TEXT.unreadable)
      if (file.revision !== revision) return error(TEXT.stale)
      try {
        const next = change(file)
        if ('kind' in next) return next
        await save(projectId, next)
        return state(next)
      } catch (raw) {
        // 加密(applyUpsert 裡的 encryptString)或寫檔任一步失敗,狀態不套用、檔案不變。
        deps.logError(raw instanceof Error ? raw : new Error(String(raw)))
        return error(TEXT.saveFailed)
      }
    })

  return {
    handle: async (raw) => {
      const parsed = TestMachinesRequestSchema.safeParse(raw)
      if (!parsed.success) return error(TEXT.badRequest)
      const request = parsed.data
      if (request.action === 'list') {
        const file = await load(request.projectId)
        return file === 'unreadable' ? error(TEXT.unreadable) : state(file)
      }
      if (request.action === 'upsert') return mutate(request.projectId, request.revision, (file) => applyUpsert(file, request.machine))
      return mutate(request.projectId, request.revision, (file) => {
        if (!file.machines.some((m) => m.id === request.id)) return error(TEXT.notFound)
        return { revision: file.revision + 1, machines: file.machines.filter((m) => m.id !== request.id) }
      })
    },
    credentialsFor: async (projectId, name) => {
      const file = await load(projectId)
      if (file === 'unreadable') return undefined
      const found = file.machines.find((m) => m.name === name)
      if (found === undefined) return undefined
      const origin = new URL(found.url).origin
      if (found.password === null) return { username: found.username, password: null, passwordUnreadable: false, origin }
      const password = decrypt(found.password)
      return { username: found.username, password, passwordUnreadable: password === null, origin }
    },
    removeProject: (projectId) => withProject(projectId, () => rm(pathOf(projectId), { force: true })),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
