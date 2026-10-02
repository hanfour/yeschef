# 測試機設定與 `view_login` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 人把測試機的網址與帳密設定在專案裡,密碼經 `safeStorage` 加密存檔;agent 只能呼叫 `view_login(machine, usernameRef, passwordRef, submitRef?)`,由主行程填表,模型看不到帳密。

**Architecture:** 主行程新增 `test-machines/service.ts`(每專案一檔、密文存檔、樂觀鎖),renderer 一個 `testMachines:manage` invoke 頻道與 `TestMachinesManager` 對話框。第九個瀏覽器工具 `view_login` 的定義加進 `tool-defs.ts`,實作在新檔 `controller-login.ts`,只組合既有的 `type`、`click` 與 ref 檢查;帳密透過每個 session 綁定的 `credentials(machine)` 閉包取得。

**Tech Stack:** Electron 44(`safeStorage`)、TypeScript 7、React 19、zod、vitest。

**Spec:** `docs/specs/2026-09-22-test-machines-design.md`

## Global Constraints

- 密碼不進 renderer、不進模型、不進對話紀錄、不進 log。回應 schema 不宣告 `password` 欄位;`MSG` 的任何文字不含帳號與密碼。
- `view_login` 填入密碼之後,不論成功、失敗或中止,回傳前一定清空密碼欄(規格 §5.2 第 7 步)。
- origin 不符時不送任何 `Input.*` 指令(規格 §5.2 第 2 步在任何輸入之前)。
- `safeStorage.isEncryptionAvailable()` 回 false 時拒絕儲存密碼,不退回明文。
- `refs.ts`、`controller-input.ts`、`settle.ts`、`watch.ts`、`snapshot*.ts` 的實作不動;`controller-login.ts` 只呼叫它們。
- 另外八個工具的名稱、參數、回傳格式不變;`view_eval` 與 codex `view_navigate` 的批准規則不變。
- 所有給人或給模型看的字串用繁體中文,主行程的集中在 `src/main/view-tools/errors.ts` 的 `MSG`。
- 不可變更新;每個函式 50 行以內(工廠函式 `createXxx(deps)` 的外層 closure 不算);每個檔案 400 行以內;縮排不超過 3 層。
- 先寫測試並確認失敗,再寫實作。測試:`npx vitest run <檔案>`;全部:`npm test`;型別:`npm run typecheck`。
- commit 訊息格式 `<type>: <description>`,結尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/shared/test-machines.ts` | 新增 | 頻道名、zod schema、型別 |
| `src/main/view-tools/errors.ts` | 修改 | 六個新的 `MSG` |
| `src/main/test-machines/service.ts` | 新增 | 每專案一檔的存取、加解密、`handle(raw)`、`credentialsFor` |
| `src/main/projects-state.ts` | 修改 | `removedProjectIds(prev, next)` |
| `src/shared/ipc.ts`、`src/preload/bridge.ts`、`tests/helpers/fake-yeschef.ts` | 修改 | `manageTestMachines` |
| `src/main/index.ts` | 修改 | 建 service、註冊 handler、專案移除時刪檔、把 `credentials` 接進 session |
| `src/shared/view-tools.ts` | 修改 | `VIEW_TOOL_NAMES` 加 `view_login` |
| `src/main/view-tools/controller-types.ts` | 修改 | `ControllerDeps.credentials`、`ViewController.login`、`Credentials` 型別 |
| `src/main/view-tools/controller-login.ts` | 新增 | `view_login` 的八步 |
| `src/main/view-tools/controller.ts`、`tool-defs.ts` | 修改 | 組裝與定義 |
| `src/main/view-tools/startup.ts`、`src/main/browser-sessions.ts` | 修改 | 多傳 `credentials` |
| `src/renderer/components/TestMachinesManager.tsx`、`.css` | 新增 | 設定對話框 |
| `src/renderer/App.tsx` | 修改 | 「測試機」按鈕與對話框 |
| `docs/RESULTS-35-test-machines.md` | 新增 | 驗收結果 |

---

### Task 1: 共用 schema 與 `MSG`

**Files:**
- Create: `src/shared/test-machines.ts`
- Modify: `src/main/view-tools/errors.ts`
- Test: `tests/test-machines-shared.test.ts`

**Interfaces:**
- Produces(`src/shared/test-machines.ts`):

```ts
export const TEST_MACHINES_CHANNEL = 'testMachines:manage'
export const MachineViewSchema   // { id, name, url, username, hasPassword } .strict()
export const MachineInputSchema  // { id?, name, url, username, password? } .strict()
export const TestMachinesRequestSchema   // discriminatedUnion('action', list | upsert | remove)
export const TestMachinesResponseSchema  // discriminatedUnion('kind', state | error)
export type MachineView, MachineInput, TestMachinesRequest, TestMachinesResponse
```

- Produces(`MSG`):`machineUnknown(name)`、`machineNoPassword(name)`、`originMismatch(origin)`、`loginRefInFrame`、`keychainUnavailable`、`loggedIn(machine, url)`,文字照規格 §6。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/test-machines-shared.test.ts
import { describe, expect, it } from 'vitest'
import {
  MachineInputSchema, MachineViewSchema, TEST_MACHINES_CHANNEL, TestMachinesRequestSchema, TestMachinesResponseSchema,
} from '../src/shared/test-machines.js'

const VIEW = { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa', hasPassword: true }

describe('測試機的 schema', () => {
  it('頻道名固定', () => {
    expect(TEST_MACHINES_CHANNEL).toBe('testMachines:manage')
  })

  it('回應的 machine 不能帶 password 欄位', () => {
    expect(MachineViewSchema.safeParse(VIEW).success).toBe(true)
    expect(MachineViewSchema.safeParse({ ...VIEW, password: 'x' }).success).toBe(false)
  })

  it('輸入的 url 只收 http 與 https', () => {
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'https://a.test/', username: 'u' }).success).toBe(true)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'http://localhost:3000', username: 'u' }).success).toBe(true)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'file:///etc/passwd', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a', url: 'not a url', username: 'u' }).success).toBe(false)
  })

  it('name 去頭尾空白後不可為空,最長 100 字', () => {
    expect(MachineInputSchema.safeParse({ name: '   ', url: 'https://a.test/', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.safeParse({ name: 'a'.repeat(101), url: 'https://a.test/', username: 'u' }).success).toBe(false)
    expect(MachineInputSchema.parse({ name: '  staging ', url: 'https://a.test/', username: 'u' }).name).toBe('staging')
  })

  it('三種請求與兩種回應', () => {
    expect(TestMachinesRequestSchema.safeParse({ action: 'list', projectId: 'p' }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'upsert', projectId: 'p', revision: 0, machine: { name: 'a', url: 'https://a.test/', username: 'u', password: 'pw' } }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'remove', projectId: 'p', revision: 1, id: 'm1' }).success).toBe(true)
    expect(TestMachinesRequestSchema.safeParse({ action: 'list', projectId: 'p', extra: 1 }).success).toBe(false)
    expect(TestMachinesResponseSchema.safeParse({ kind: 'state', revision: 2, machines: [VIEW] }).success).toBe(true)
    expect(TestMachinesResponseSchema.safeParse({ kind: 'error', message: '壞了' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/test-machines-shared.test.ts`
Expected: FAIL,找不到 `../src/shared/test-machines.js`

- [ ] **Step 3: 實作**

```ts
// src/shared/test-machines.ts
import { z } from 'zod'

export const TEST_MACHINES_CHANNEL = 'testMachines:manage'

/** 只收 http 與 https:file:// 的測試機不成立,其他協定也沒有登入頁可填。 */
function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const nameSchema = z.string().trim().min(1).max(100)
const urlSchema = z.string().max(2000).refine(isHttpUrl, { message: '網址必須是 http 或 https' })

/** renderer 看到的一筆。沒有 password 欄位,strict 讓多出來的也進不來。 */
export const MachineViewSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  url: urlSchema,
  username: z.string().max(200),
  hasPassword: z.boolean(),
}).strict()

/** 表單送來的一筆。password 是 undefined 表示保留原本的。 */
export const MachineInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: nameSchema,
  url: urlSchema,
  username: z.string().max(200),
  password: z.string().max(1000).optional(),
}).strict()

export const TestMachinesRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('upsert'), projectId: z.string().min(1), revision: z.number().int().nonnegative(), machine: MachineInputSchema }).strict(),
  z.object({ action: z.literal('remove'), projectId: z.string().min(1), revision: z.number().int().nonnegative(), id: z.string().min(1) }).strict(),
])

export const TestMachinesResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), revision: z.number().int().nonnegative(), machines: z.array(MachineViewSchema) }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])

export type MachineView = z.infer<typeof MachineViewSchema>
export type MachineInput = z.infer<typeof MachineInputSchema>
export type TestMachinesRequest = z.infer<typeof TestMachinesRequestSchema>
export type TestMachinesResponse = z.infer<typeof TestMachinesResponseSchema>
```

`src/main/view-tools/errors.ts` 的 `MSG`,在 `badCommand` 之後加:

```ts
  machineUnknown: (name: string) => `沒有叫 ${name} 的測試機,請到專案的測試機設定新增`,
  machineNoPassword: (name: string) => `測試機 ${name} 沒有設定密碼`,
  originMismatch: (origin: string) => `目前頁面不是 ${origin},不會填入帳密`,
  loginRefInFrame: '帳密欄位必須在主框架,不能在跨站 iframe 裡',
  keychainUnavailable: '這台電腦的鑰匙圈不可用,無法儲存密碼',
  loggedIn: (machine: string, url: string) => `已用 ${machine} 的帳密送出登入,目前網址 ${url}`,
```

`tests/view-tools/errors.test.ts` 若逐一列舉 `MSG` 的鍵,補上這六個。

- [ ] **Step 4: 跑測試**

Run: `npx vitest run tests/test-machines-shared.test.ts tests/view-tools/errors.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/test-machines.ts src/main/view-tools/errors.ts tests/test-machines-shared.test.ts tests/view-tools/errors.test.ts
git commit -m "feat: add test machine schema and login messages"
```

---
### Task 2: 主行程的 service

**Files:**
- Create: `src/main/test-machines/service.ts`
- Test: `tests/test-machines-service.test.ts`

**Interfaces:**
- Consumes:Task 1 的 schema 與 `MSG.keychainUnavailable`
- Produces:

```ts
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}
export interface Credentials { readonly username: string; readonly password: string | null; readonly passwordUnreadable: boolean; readonly origin: string }
export interface TestMachinesService {
  handle(raw: unknown): Promise<TestMachinesResponse>
  credentialsFor(projectId: string, name: string): Promise<Credentials | undefined>
  removeProject(projectId: string): Promise<void>
}
export function createTestMachinesService(deps: { dir: string; safeStorage: SafeStorageLike; logError(e: Error): void; newId?: () => string }): TestMachinesService
```

存檔格式(規格 §3.1):`{ revision, machines: [{ id, name, url, username, password: string | null }] }`,`password` 是密文的 base64。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/test-machines-service.test.ts
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
let logError: ReturnType<typeof vi.fn>
let service: TestMachinesService
const MACHINE = { name: 'staging', url: 'https://staging.test/login', username: 'qa', password: 's3cret' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-'))
  safe = fakeSafeStorage()
  logError = vi.fn()
  let n = 0
  service = createTestMachinesService({ dir, safeStorage: safe, logError, newId: () => `id-${++n}` })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function upsert(machine: object, revision = 0, projectId = 'p1') {
  return service.handle({ action: 'upsert', projectId, revision, machine })
}

describe('list 與 upsert', () => {
  it('空專案回空清單,revision 0', async () => {
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'state', revision: 0, machines: [] })
  })

  it('存一筆:回應沒有 password 欄位,檔案裡是密文不是明文', async () => {
    const res = await upsert(MACHINE)
    expect(res).toEqual({ kind: 'state', revision: 1, machines: [{ id: 'id-1', name: 'staging', url: MACHINE.url, username: 'qa', hasPassword: true }] })
    const raw = await readFile(join(dir, 'p1.json'), 'utf8')
    expect(raw).not.toContain('s3cret')
    expect(raw).toContain(Buffer.from('enc:terc3s').toString('base64'))
    expect((await stat(join(dir, 'p1.json'))).mode & 0o777).toBe(0o600)
  })

  it('credentialsFor 解回明文與 origin', async () => {
    await upsert(MACHINE)
    await expect(service.credentialsFor('p1', 'staging')).resolves.toEqual({ username: 'qa', password: 's3cret', origin: 'https://staging.test' })
    await expect(service.credentialsFor('p1', 'nope')).resolves.toBeUndefined()
    await expect(service.credentialsFor('p2', 'staging')).resolves.toBeUndefined()
  })

  it('編輯時不帶 password 保留原密文', async () => {
    await upsert(MACHINE)
    const res = await upsert({ id: 'id-1', name: 'staging2', url: MACHINE.url, username: 'qa2' }, 1)
    expect(res).toMatchObject({ kind: 'state', revision: 2, machines: [{ id: 'id-1', name: 'staging2', username: 'qa2', hasPassword: true }] })
    await expect(service.credentialsFor('p1', 'staging2')).resolves.toMatchObject({ password: 's3cret' })
  })

  it('沒設密碼:hasPassword false,credentialsFor 的 password 是 null', async () => {
    await upsert({ name: 'nopw', url: 'https://a.test/', username: 'u' })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ machines: [{ hasPassword: false }] })
    await expect(service.credentialsFor('p1', 'nopw')).resolves.toEqual({ username: 'u', password: null, origin: 'https://a.test' })
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
})

describe('壞掉的檔案與密文', () => {
  it('檔案損毀:list 回 error,不清空、不覆寫', async () => {
    await writeFile(join(dir, 'p1.json'), '{not json', { mode: 0o600 })
    await expect(service.handle({ action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'error', message: '測試機設定檔無法讀取,請檢查主程序紀錄' })
    expect(await readFile(join(dir, 'p1.json'), 'utf8')).toBe('{not json')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('密文解不開:hasPassword false、password null、logError 一次', async () => {
    await upsert(MACHINE)
    const path = join(dir, 'p1.json')
    const stored = JSON.parse(await readFile(path, 'utf8')) as { machines: { password: string }[] }
    stored.machines[0]!.password = Buffer.from('garbage').toString('base64')
    await writeFile(path, JSON.stringify(stored))
    const fresh = createTestMachinesService({ dir, safeStorage: safe, logError })
    await expect(fresh.handle({ action: 'list', projectId: 'p1' })).resolves.toMatchObject({ machines: [{ hasPassword: false }] })
    await expect(fresh.credentialsFor('p1', 'staging')).resolves.toMatchObject({ password: null })
    // list 與 credentialsFor 各讀檔一次,每次讀檔對解不開的密文記一次錯
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/test-machines-service.test.ts`
Expected: FAIL,找不到 `service.js`

- [ ] **Step 3: 實作**

```ts
// src/main/test-machines/service.ts
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { TestMachinesRequestSchema, type MachineInput, type MachineView, type TestMachinesResponse } from '../../shared/test-machines.js'
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
  id: z.string().min(1), name: z.string(), url: z.string(), username: z.string(),
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
} as const

const error = (message: string): TestMachinesResponse => ({ kind: 'error', message })

export function createTestMachinesService(deps: TestMachinesDeps): TestMachinesService {
  const newId = deps.newId ?? randomUUID
  const pathOf = (projectId: string): string => join(deps.dir, `${projectId}.json`)
  /** 每個專案一條寫入佇列,同專案的寫入依序,不同專案互不等待。 */
  let queues: ReadonlyMap<string, Promise<void>> = new Map()

  const decrypt = (cipher: string | null): string | null => {
    if (cipher === null) return null
    try {
      return deps.safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (raw) {
      deps.logError(new Error('測試機的密碼密文解不開,請重新設定密碼', { cause: raw }))
      return null
    }
  }

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
    // 讀檔時就對每筆密文試解一次:解不開的當成沒設密碼(不寫回檔案),之後不用再解。
    const machines = parsed.data.machines.map((m) => (m.password !== null && decrypt(m.password) === null ? { ...m, password: null } : m))
    return { revision: parsed.data.revision, machines }
  }

  const save = async (projectId: string, file: StoredFile): Promise<void> => {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 })
    const path = pathOf(projectId)
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    await rename(tmp, path)
  }

  /** 同一個專案的讀改寫串在一條佇列上,兩個 upsert 同時來不會互相蓋掉。 */
  const withProject = <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(projectId) ?? Promise.resolve()
    const task = previous.then(work, work)
    queues = new Map([...queues, [projectId, task.then(() => {}, () => {})]])
    return task
  }

  const toView = (m: StoredMachine): MachineView => ({
    id: m.id, name: m.name, url: m.url, username: m.username, hasPassword: m.password !== null,
  })
  const state = (file: StoredFile): TestMachinesResponse => ({ kind: 'state', revision: file.revision, machines: file.machines.map(toView) })

  const applyUpsert = (file: StoredFile, input: MachineInput): StoredFile | TestMachinesResponse => {
    const existing = file.machines.find((m) => m.id === input.id)
    if (file.machines.some((m) => m.name === input.name && m !== existing)) return error(TEXT.duplicate(input.name))
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
      const next = change(file)
      if ('kind' in next) return next
      await save(projectId, next)
      return state(next)
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
      return { username: found.username, password: decrypt(found.password), origin: new URL(found.url).origin }
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
```

`error` 與 `state` 的回傳都要過 `TestMachinesResponseSchema` 的形狀;`state()` 只放 `kind`、`revision`、`machines`,不放別的。

- [ ] **Step 4: 跑測試**

Run: `npx vitest run tests/test-machines-service.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/test-machines tests/test-machines-service.test.ts
git commit -m "feat: store test machine credentials with safeStorage"
```

---
### Task 3: IPC 接線與專案移除時刪檔

**Files:**
- Modify: `src/main/projects-state.ts`(加 `removedProjectIds`)
- Modify: `src/shared/ipc.ts`(`YesChefApi.manageTestMachines`)
- Modify: `src/preload/bridge.ts`
- Modify: `tests/helpers/fake-yeschef.ts`
- Modify: `src/main/index.ts`
- Test: `tests/projects-state.test.ts`、`tests/preload-bridge.test.ts`

**Interfaces:**
- Consumes:Task 1 的 `TEST_MACHINES_CHANNEL`、schema;Task 2 的 `createTestMachinesService`
- Produces:`removedProjectIds(prev: ProjectsState, next: ProjectsState): readonly string[]`;`YesChefApi.manageTestMachines(payload: TestMachinesRequest): Promise<TestMachinesResponse>`;`index.ts` 裡的 `testMachines` service 實例(Task 5 用它的 `credentialsFor`)

- [ ] **Step 1: 寫失敗的測試**

`tests/projects-state.test.ts` 加(`entry`、`stateOf`、`convTab` 是前一份計畫加進去的 helper,已在檔案裡):

```ts
import { removedProjectIds } from '../src/main/projects-state.js'

describe('removedProjectIds', () => {
  it('prev 有、next 沒有的專案 id;順序照 prev', () => {
    const a = { ...entry([convTab('a', 0)], null), id: 'pa' }
    const b = { ...entry([convTab('b', 0)], null), id: 'pb' }
    const prev: ProjectsState = { ...stateOf(a), projects: [a, b] }
    const next: ProjectsState = { ...stateOf(b), projects: [b] }
    expect(removedProjectIds(prev, next)).toEqual(['pa'])
    expect(removedProjectIds(next, prev)).toEqual([])
    expect(removedProjectIds(prev, prev)).toEqual([])
  })
})
```

`tests/preload-bridge.test.ts` 加(沿用該檔的 `replies`、`invoked`、`loadBridge()` 寫法,跟 `managePermissions` 的既有測試同一個形狀):

```ts
  it('manageTestMachines:請求先過 schema,回應過 schema,壞的回應 reject', async () => {
    replies.set('testMachines:manage', { kind: 'state', revision: 0, machines: [] })
    const api = loadBridge()
    await expect(api.manageTestMachines({ action: 'list', projectId: 'p' })).resolves.toEqual({ kind: 'state', revision: 0, machines: [] })
    expect(invoked.at(-1)).toEqual(['testMachines:manage', { action: 'list', projectId: 'p' }])
    replies.set('testMachines:manage', { kind: 'state', revision: 0, machines: [{ id: 'm', name: 'a', url: 'https://a.test/', username: 'u', hasPassword: false, password: 'leak' }] })
    await expect(api.manageTestMachines({ action: 'list', projectId: 'p' })).rejects.toThrow('測試機設定回傳格式不正確')
  })
```

第二段是這個 Task 的重點:主行程若有一天多送了 `password`,preload 的 schema 會把整個回應擋下來。

Run: `npx vitest run tests/projects-state.test.ts tests/preload-bridge.test.ts`
Expected: FAIL

- [ ] **Step 2: 實作**

`src/main/projects-state.ts`,放在 `findProjectByTab` 附近:

```ts
/** prev 有、next 沒有的專案 id。測試機規格 §3.1:專案被移除時一併刪掉它的帳密檔。 */
export function removedProjectIds(prev: ProjectsState, next: ProjectsState): readonly string[] {
  const nextIds = new Set(next.projects.map((p) => p.id))
  return prev.projects.map((p) => p.id).filter((id) => !nextIds.has(id))
}
```

`src/shared/ipc.ts`:import `type { TestMachinesRequest, TestMachinesResponse } from './test-machines.js'`;`YesChefApi` 在 `manageSkills` 後面加 `manageTestMachines(payload: TestMachinesRequest): Promise<TestMachinesResponse>`。

`src/preload/bridge.ts`:import `TEST_MACHINES_CHANNEL, TestMachinesRequestSchema, TestMachinesResponseSchema`;`api` 在 `manageSkills` 後面加:

```ts
  manageTestMachines: (payload) => {
    return invokeParsed(TEST_MACHINES_CHANNEL, TestMachinesRequestSchema.parse(payload), (raw) => {
      const result = TestMachinesResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '測試機設定回傳格式不正確')
  },
```

`tests/helpers/fake-yeschef.ts` 的假 API 加 `manageTestMachines: async () => ({ kind: 'state', revision: 0, machines: [] }),`。

`src/main/index.ts`:

1. import `safeStorage` 加進 electron 的 import;import `createTestMachinesService`、`TEST_MACHINES_CHANNEL`、`removedProjectIds`。
2. 在 `permissions` 建好之後加:

```ts
  // 測試機規格 §3:密碼經 safeStorage 加密後存在 userData,每個專案一檔。
  const testMachines = createTestMachinesService({
    dir: join(app.getPath('userData'), 'test-machines'),
    safeStorage,
    logError,
  })
  // 專案被移除就刪它的帳密檔,不留孤兒。
  const unsubscribeTestMachines = service.subscribe((next, prev) => {
    for (const id of removedProjectIds(prev, next)) {
      testMachines.removeProject(id).catch((err: unknown) => { logError(toError(err)) })
    }
  })
```

3. 在 `ipcMain.handle(PERMISSIONS_CHANNEL, …)` 旁邊加,並在同一個 `win.once('closed')` 裡 `removeHandler`:

```ts
  ipcMain.handle(TEST_MACHINES_CHANNEL, async (event, raw: unknown) => {
    if (event.sender !== conversationView.webContents) return { kind: 'error', message: '不接受此來源的測試機請求' }
    return testMachines.handle(raw)
  })
```

4. `closed` handler 裡呼叫 `unsubscribeTestMachines()`。

`service.subscribe` 的回傳型別以 `projects-service.ts` 為準;它回的若不是函式,改用該檔提供的取消訂閱方式。

- [ ] **Step 3: 跑測試**

Run: `npm test && npm run typecheck`
Expected: PASS。`tests/ipc.test.ts` 若逐字比對 `YesChefApi` 的方法清單,補上 `manageTestMachines`。

- [ ] **Step 4: Commit**

```bash
git add src/main/projects-state.ts src/shared/ipc.ts src/preload/bridge.ts src/main/index.ts tests/helpers/fake-yeschef.ts tests/projects-state.test.ts tests/preload-bridge.test.ts
git commit -m "feat: expose test machine settings over IPC"
```

---
### Task 4: `view_login` 工具

**Files:**
- Modify: `src/shared/view-tools.ts`(`VIEW_TOOL_NAMES`)
- Modify: `src/main/view-tools/controller-types.ts`(`Credentials`、`ControllerDeps.credentials`、`ViewController.login`)
- Create: `src/main/view-tools/controller-login.ts`
- Modify: `src/main/view-tools/controller.ts`、`src/main/view-tools/tool-defs.ts`
- Modify: `tests/view-tools/controller-harness.ts`(多收 `credentials`)
- Test: `tests/view-tools/controller-login.test.ts`(新)、`tests/view-tools/view-tools-shared.test.ts`、`tests/view-tools/tool-defs.test.ts`、`tests/view-tools/policy.test.ts`

**Interfaces:**
- Consumes:`MSG` 的六個新訊息(Task 1);`ControllerCore`(`guard`、`resolveEntry`、`deps.webContents`、`deps.logError`);`createInputTools(core)` 回的 `type`、`click`
- Produces:

```ts
// controller-types.ts
export interface Credentials { readonly username: string; readonly password: string | null; readonly passwordUnreadable: boolean; readonly origin: string }
export interface ControllerDeps { …; readonly credentials: (machine: string) => Promise<Credentials | undefined> }
export interface ViewController { …; login(machine: string, usernameRef: string, passwordRef: string, submitRef: string | undefined, signal: AbortSignal): Promise<ToolOutput> }
// controller-login.ts
export function createLoginTools(core: ControllerCore, input: Pick<ViewController, 'type' | 'click' | 'press'>): Pick<ViewController, 'login'>
```

`Credentials` 定義在 `controller-types.ts`;Task 2 的 service 有一個同名同形的型別,Task 5 接線時用 service 的回傳直接餵,兩邊形狀相同不需要轉換。

`click` 與 `type(submit=true)` 自己會等頁面靜默(`waitQuiet`),所以規格 §5.2 的第 5、6 步在這裡是同一個呼叫。`watcher.runAsAgent` 可以巢狀,`login` 不自己包 `core.act`,只在開頭 `core.guard(signal)`,之後每一步呼叫 `input.type` / `input.click` 各自包。

- [ ] **Step 1: 加工具名,修三個列舉名稱的測試**

`src/shared/view-tools.ts` 的 `VIEW_TOOL_NAMES` 在 `'request_handoff'` 後面加 `'view_login'`。

`tests/view-tools/view-tools-shared.test.ts`:名稱清單的斷言加 `'view_login'` 在最後;測試標題「八個」改「九個」。`tests/view-tools/tool-defs.test.ts` 頂端的 JSON Schema 對照表加一筆:

```ts
  view_login: { required: ['machine', 'usernameRef', 'passwordRef'], properties: ['machine', 'usernameRef', 'passwordRef', 'submitRef'] },
```

(欄位名以該表既有的形狀為準。)標題「八個」改「九個」。`tests/view-tools/policy.test.ts` 加:

```ts
  it('view_login 自動放行,codex 也是', () => {
    expect(viewToolPolicy(fullToolName('view_login'))).toBe('allow')
    expect(viewToolPolicy(fullToolName('view_login'), 'codex')).toBe('allow')
  })
```

`tests/view-tools/server.test.ts`、`tests/codex-conversation.test.ts` 的斷言用的是 `[...VIEW_TOOL_NAMES]`,不用改;標題裡的「八個」改「九個」。

Run: `npx vitest run tests/view-tools/view-tools-shared.test.ts tests/view-tools/tool-defs.test.ts tests/view-tools/policy.test.ts`
Expected: shared 與 policy PASS(`policy.ts` 的放行表由 `VIEW_TOOL_NAMES` 產生);tool-defs FAIL(還沒有第九個定義)

- [ ] **Step 2: 型別與 harness**

`src/main/view-tools/controller-types.ts`:加 `Credentials` 介面;`ControllerDeps` 加:

```ts
  /** 測試機規格 §5.4:這個 session 所屬專案的測試機帳密。每次呼叫才查,對話不在任何專案裡時回 undefined。 */
  readonly credentials: (machine: string) => Promise<Credentials | undefined>
```

`ViewController` 加 `login(...)`(簽名如上)。

`tests/view-tools/controller-harness.ts`:`createHarness(projectDir = '/tmp/yeschef-proj', credentials: ControllerDeps['credentials'] = async () => undefined)`,傳進 `createViewController`。`Harness` 介面不變。

Run: `npm run typecheck`
Expected: 只剩 `controller.ts` 缺 `login` 與 `browser-sessions`/`startup`/`index` 缺 `credentials` 的錯誤(Task 5 處理後面三個;這一步先在 `startup.ts` 傳 `credentials: async () => undefined` 讓型別過,Task 5 再換成真的)。

- [ ] **Step 3: 寫失敗的測試**

```ts
// tests/view-tools/controller-login.test.ts
import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import { MSG } from '../../src/main/view-tools/errors.js'
import { invalidateRefs } from '../../src/main/view-tools/refs.js'
import type { Credentials } from '../../src/main/view-tools/controller.js'
import { createHarness, refTable, sent, type Harness } from './controller-harness.js'

const STAGING: Credentials = { username: 'qa', password: 's3cret', passwordUnreadable: false, origin: 'https://staging.test' }
const ROOT_BORDER = [10, 10, 30, 10, 30, 30, 10, 30]

let h: Harness
let lookups: string[]

/** 帳號欄 s1-e0、密碼欄 s1-e1、送出鈕 s1-e2、跨站 iframe 裡的欄位 s1-e3。 */
async function setup(credentials: Record<string, Credentials | undefined> = { staging: STAGING }, url = 'https://staging.test/login') {
  lookups = []
  h = await createHarness('/tmp/proj', async (machine) => { lookups.push(machine); return credentials[machine] })
  h.wc.setUrl(url)
  h.watcher.setRefs(refTable(1, [
    ['s1-e0', { backendNodeId: 1, role: 'textbox', name: '帳號' }],
    ['s1-e1', { backendNodeId: 2, role: 'textbox', name: '密碼' }],
    ['s1-e2', { backendNodeId: 3, role: 'button', name: '登入' }],
    ['s1-e3', { backendNodeId: 4, role: 'textbox', name: '外站', sessionId: 'oopif-1' }],
  ]))
  for (const method of ['DOM.focus', 'Input.dispatchKeyEvent', 'Input.insertText', 'DOM.scrollIntoViewIfNeeded', 'Input.dispatchMouseEvent']) {
    h.cdp.onSend(method, () => ({}))
  }
  h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: ROOT_BORDER } }))
}

/** 每次 Input.insertText 送出的文字,依序。 */
const inserted = () => sent(h.cdp, 'Input.insertText').map((c) => (c.params as { text: string }).text)
/** 送出的 Input.* 指令數。 */
const inputCount = () => (h.cdp.send as unknown as Mock).mock.calls.filter((c) => String(c[0]).startsWith('Input.')).length

beforeEach(() => setup())

describe('view_login 的前置檢查', () => {
  it('沒有這台測試機:回 machineUnknown,不送任何 Input 指令', async () => {
    await expect(h.controller.login('nope', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machineUnknown('nope'))
    expect(inputCount()).toBe(0)
    expect(lookups).toEqual(['nope'])
  })

  it('沒設密碼:回 machineNoPassword', async () => {
    await setup({ staging: { ...STAGING, password: null } })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machineNoPassword('staging'))
    expect(inputCount()).toBe(0)
  })

  it('密文解不開:回 machinePasswordUnreadable', async () => {
    await setup({ staging: { ...STAGING, password: null, passwordUnreadable: true } })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machinePasswordUnreadable('staging'))
    expect(inputCount()).toBe(0)
  })

  it('目前頁面的 origin 不是測試機的:回 originMismatch,不送任何 Input 指令', async () => {
    await setup({ staging: STAGING }, 'https://evil.test/login')
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.originMismatch('https://staging.test'))
    expect(inputCount()).toBe(0)
  })

  it('同 origin 不同路徑可以', async () => {
    await setup({ staging: STAGING }, 'https://staging.test/admin/login?next=/')
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).resolves.toMatchObject({ kind: 'text' })
  })

  it('ref 壞掉:格式錯、不在表裡,各回對應訊息且不送 Input', async () => {
    await expect(h.controller.login('staging', 'x', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.refFormat)
    await expect(h.controller.login('staging', 's1-e0', 's1-e9', undefined, h.signal)).rejects.toThrow(MSG.refMissing(1, 's1-e9'))
    expect(inputCount()).toBe(0)
  })

  it('任一個 ref 在跨站 iframe 裡:回 loginRefInFrame,不送 Input', async () => {
    await expect(h.controller.login('staging', 's1-e3', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.loginRefInFrame)
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', 's1-e3', h.signal)).rejects.toThrow(MSG.loginRefInFrame)
    expect(inputCount()).toBe(0)
  })
})

describe('填表與送出', () => {
  it('沒有 submitRef:帳號、密碼依序填入,密碼欄按 Enter,最後清空密碼欄', async () => {
    const out = await h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)
    expect(inserted()).toEqual(['qa', 's3cret', ''])
    const enters = sent(h.cdp, 'Input.dispatchKeyEvent').filter((c) => (c.params as { key?: string }).key === 'Enter')
    expect(enters.length).toBeGreaterThan(0)
    expect(out).toEqual({ kind: 'text', text: MSG.loggedIn('staging', 'https://staging.test/login') })
  })

  it('有 submitRef:點它而不是按 Enter', async () => {
    await h.controller.login('staging', 's1-e0', 's1-e1', 's1-e2', h.signal)
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(2)
    expect(sent(h.cdp, 'Input.dispatchKeyEvent').filter((c) => (c.params as { key?: string }).key === 'Enter')).toHaveLength(0)
    expect(inserted()).toEqual(['qa', 's3cret', ''])
  })

  it('回傳文字與 log 都不含帳號與密碼', async () => {
    const out = await h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)
    const text = JSON.stringify(out)
    expect(text).not.toContain('qa')
    expect(text).not.toContain('s3cret')
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain('s3cret')
  })

  it('送出時失敗(點擊丟例外):仍然清空密碼欄,錯誤原樣往上丟', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => { throw new Error('boom') })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', 's1-e2', h.signal)).rejects.toThrow()
    expect(inserted().at(-1)).toBe('')
  })

  it('填密碼之後 signal 中止:仍然清空密碼欄', async () => {
    let calls = 0
    h.cdp.onSend('Input.insertText', () => {
      calls += 1
      if (calls === 2) h.aborter.abort()
      return {}
    })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow()
    expect(inserted()).toEqual(['qa', 's3cret', ''])
  })

  it('送出後頁面跳轉、ref 表失效:清空這一步略過,不記錯誤', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://staging.test/home')
      h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'navigation'))
      return {}
    })
    const out = await h.controller.login('staging', 's1-e0', 's1-e1', 's1-e2', h.signal)
    expect(inserted()).toEqual(['qa', 's3cret'])
    expect(h.logError).not.toHaveBeenCalled()
    expect(out).toEqual({ kind: 'text', text: MSG.loggedIn('staging', 'https://staging.test/home') })
  })
})
```

`invalidateRefs` 的第二個參數以 `refs.ts` 的 `InvalidationReason` 為準。`h.aborter.abort()` 之後 `input.type` 的 `core.act` 會在 `guard` 就丟;清空那一步要用新的 signal(見實作)。

Run: `npx vitest run tests/view-tools/controller-login.test.ts`
Expected: FAIL,`h.controller.login is not a function`

- [ ] **Step 4: 實作 `controller-login.ts`**

```ts
// src/main/view-tools/controller-login.ts
/**
 * view_login(測試機規格 §5.2):帳密由主行程填,模型只給 ref。
 * 這裡不碰 CDP,只組合 controller-input 的 type／click 與 core 的 ref 查表;
 * 順序固定:查帳密 → origin → ref → 填帳號 → 填密碼 → 送出 → 清空密碼欄。
 */
import type { ControllerCore } from './controller-core.js'
import { text } from './controller-core.js'
import type { ToolOutput, ViewController } from './controller-types.js'
import { MSG, ViewToolError } from './errors.js'
import type { RefEntry } from './types.js'

type Input = Pick<ViewController, 'type' | 'click' | 'press'>

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function createLoginTools(core: ControllerCore, input: Input): Pick<ViewController, 'login'> {
  const resolveMainFrame = (ref: string): RefEntry => {
    const entry = core.resolveEntry(ref)
    // 跨站 iframe 有自己的 sessionId;同站的 iframe 跟主框架同一個行程,sessionId 是 undefined。
    if (entry.sessionId !== undefined) throw new ViewToolError(MSG.loginRefInFrame)
    return entry
  }

  /**
   * 回傳前一定清空密碼欄(規格 §5.2 第 7 步)。用新的 signal:原本的可能已經中止,
   * 但清空不能跟著被略過。ref 因為頁面跳轉而失效是正常結束,其他錯誤才記。
   */
  const clearPassword = async (passwordRef: string): Promise<void> => {
    try {
      await input.type(passwordRef, '', true, false, new AbortController().signal)
    } catch (raw) {
      if (!(raw instanceof ViewToolError)) core.deps.logError(raw instanceof Error ? raw : new Error(String(raw)))
    }
  }

  /** 沒有送出鈕就按 Enter:type 之後焦點還在密碼欄。click 與 press 都會自己等頁面靜默。 */
  const submit = (submitRef: string | undefined, signal: AbortSignal): Promise<ToolOutput> =>
    submitRef === undefined ? input.press('Enter', signal) : input.click(submitRef, signal)

  return {
    login: async (machine, usernameRef, passwordRef, submitRef, signal) => {
      core.guard(signal)
      const found = await core.deps.credentials(machine)
      if (found === undefined) throw new ViewToolError(MSG.machineUnknown(machine))
      if (found.password === null) throw new ViewToolError(found.passwordUnreadable ? MSG.machinePasswordUnreadable(machine) : MSG.machineNoPassword(machine))
      if (originOf(core.deps.webContents.getURL()) !== found.origin) throw new ViewToolError(MSG.originMismatch(found.origin))
      resolveMainFrame(usernameRef)
      resolveMainFrame(passwordRef)
      if (submitRef !== undefined) resolveMainFrame(submitRef)
      await input.type(usernameRef, found.username, true, false, signal)
      try {
        await input.type(passwordRef, found.password, true, false, signal)
        await submit(submitRef, signal)
      } finally {
        await clearPassword(passwordRef)
      }
      return text(MSG.loggedIn(machine, core.deps.webContents.getURL()))
    },
  }
}
```

`src/main/view-tools/controller.ts`:

```ts
import { createLoginTools } from './controller-login.js'
// …
  const login = createLoginTools(core, input)
  return { …, login: login.login }
```

`src/main/view-tools/tool-defs.ts`:`TOOL_DESCRIPTIONS` 加

```ts
  view_login: '用專案裡設定好的測試機帳密登入。先 view_snapshot 找到帳號欄與密碼欄的 ref。帳密由主行程填入，不會回傳給你。',
```

`VIEW_TOOL_DEFS` 最後加:

```ts
  defineTool('view_login', {
    machine: z.string(), usernameRef: z.string(), passwordRef: z.string(), submitRef: z.string().optional(),
  }, (c, a, _ctx, signal) => c.login(a.machine, a.usernameRef, a.passwordRef, a.submitRef, signal)),
```

檔頭註解的「八個」改「九個」。

- [ ] **Step 5: 跑測試**

Run: `npx vitest run tests/view-tools && npm run typecheck`
Expected: PASS。`tests/view-tools/server.test.ts` 若有 mock controller 物件(`shared.controller = { navigate: …, requestHandoff: … }`),加 `login: resolving(OK_TEXT)`,否則第九個工具的 handler 會找不到方法。

- [ ] **Step 6: Commit**

```bash
git add src/shared/view-tools.ts src/main/view-tools tests/view-tools
git commit -m "feat: add view_login browser tool"
```

---
### Task 5: 把 `credentials` 接進每個 session

**Files:**
- Modify: `src/main/view-tools/startup.ts`、`src/main/browser-sessions.ts`、`src/main/index.ts`
- Test: `tests/view-tools/startup.test.ts`、`tests/browser-sessions.test.ts`

**Interfaces:**
- Consumes:Task 3 的 `testMachines.credentialsFor`;Task 4 的 `ControllerDeps.credentials`
- Produces:`ViewToolStartupDeps.credentials`、`StartToolsArgs.credentials`、`BrowserSessionsDeps.credentialsOf(conversationId, machine)`

- [ ] **Step 1: 寫失敗的測試**

`tests/browser-sessions.test.ts`:`setup()` 的 deps 加 `credentialsOf: (id, machine) => Promise.resolve({ username: `u-${id}`, password: 'p', origin: `https://${machine}.test` })`;在 `describe('ensure', …)` 加:

```ts
  it('startTools 收到的 credentials 綁定這個對話的 id', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await expect(startArgs.get('a')?.credentials('staging')).resolves.toEqual({ username: 'u-a', password: 'p', origin: 'https://staging.test' })
  })
```

`tests/view-tools/startup.test.ts`:`baseDeps()` 加 `credentials: async () => undefined`;加一條「`credentials` 原樣交給 `create`」,寫法同既有的 `onBusyChange` 那條(`toBe(credentials)`)。

Run: `npx vitest run tests/browser-sessions.test.ts tests/view-tools/startup.test.ts`
Expected: FAIL

- [ ] **Step 2: 實作**

`src/main/view-tools/startup.ts`:`ViewToolStartupDeps` 加 `readonly credentials: ViewToolDeps['credentials']`,傳給 `deps.create({ …, credentials: deps.credentials })`。Task 4 Step 2 暫放的 `credentials: async () => undefined` 刪掉。`server.ts` 的 `ViewToolDeps` 加同名欄位並傳進 `createViewController`。

`src/main/browser-sessions.ts`:

```ts
export interface StartToolsArgs {
  readonly view: WebContentsView
  readonly projectDir: () => string
  readonly credentials: (machine: string) => Promise<Credentials | undefined>
  readonly onBusyChange: (busy: boolean) => void
}
// BrowserSessionsDeps 加:
  /** 測試機規格 §5.4:這個對話所屬專案的測試機帳密;每次呼叫才查專案。 */
  credentialsOf(conversationId: string, machine: string): Promise<Credentials | undefined>
```

`build()` 裡:`deps.startTools({ view, projectDir: projectDir(id), credentials: (machine) => deps.credentialsOf(id, machine), onBusyChange: pushSessions })`。`Credentials` 從 `./view-tools/controller-types.js` import。

`src/main/index.ts`:`createBrowserSessions` 的 deps 加

```ts
    credentialsOf: async (conversationId, machine) => {
      const project = findProjectByTab(service.state(), conversationId)
      return project === undefined ? undefined : testMachines.credentialsFor(project.id, machine)
    },
```

`startTools` 的箭頭函式多解構 `credentials` 並傳給 `startViewTools`。

- [ ] **Step 3: 跑測試**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/view-tools/startup.ts src/main/view-tools/server.ts src/main/browser-sessions.ts src/main/index.ts tests/browser-sessions.test.ts tests/view-tools/startup.test.ts
git commit -m "feat: give each browser session access to its project's test machines"
```

---

### Task 6: 設定對話框

**Files:**
- Create: `src/renderer/components/TestMachinesManager.tsx`、`src/renderer/components/TestMachinesManager.css`
- Modify: `src/renderer/App.tsx`
- Test: `tests/test-machines-manager.test.tsx`

**Interfaces:**
- Consumes:`YesChefApi.manageTestMachines`(Task 3)、`MachineView`、`TestMachinesRequest`(Task 1)
- Produces:`TestMachinesManager({ api, projectId, projectName, onClose })`

- [ ] **Step 1: 寫失敗的測試**

```tsx
// tests/test-machines-manager.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TestMachinesManager } from '../src/renderer/components/TestMachinesManager.js'
import type { TestMachinesRequest, TestMachinesResponse } from '../src/shared/test-machines.js'

afterEach(cleanup)
beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn() })

const STAGING = { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa', hasPassword: true }

function setup(initial: TestMachinesResponse = { kind: 'state', revision: 1, machines: [STAGING] }) {
  const requests: TestMachinesRequest[] = []
  let next: TestMachinesResponse = initial
  const api = {
    manageTestMachines: vi.fn(async (request: TestMachinesRequest) => { requests.push(request); return next }),
  }
  const onClose = vi.fn()
  render(<TestMachinesManager api={api} projectId="p1" projectName="yeschef" onClose={onClose} />)
  return { requests, onClose, reply: (r: TestMachinesResponse) => { next = r } }
}

describe('TestMachinesManager', () => {
  it('開啟時列出目前專案的測試機與密碼狀態', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    expect(requests[0]).toEqual({ action: 'list', projectId: 'p1' })
    expect(screen.getByText('https://staging.test/login')).toBeTruthy()
    expect(screen.getByText('已設定')).toBeTruthy()
  })

  it('新增:四欄送 upsert,帶目前的 revision', async () => {
    const { requests, reply } = setup()
    await screen.findByText('staging')
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: 'uat' } })
    fireEvent.change(screen.getByLabelText('網址'), { target: { value: 'https://uat.test/' } })
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'tester' } })
    fireEvent.change(screen.getByLabelText('密碼'), { target: { value: 'pw' } })
    reply({ kind: 'state', revision: 2, machines: [STAGING, { id: 'm2', name: 'uat', url: 'https://uat.test/', username: 'tester', hasPassword: true }] })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'upsert', projectId: 'p1', revision: 1, machine: { name: 'uat', url: 'https://uat.test/', username: 'tester', password: 'pw' } }) })
    await screen.findByText('uat')
    expect((screen.getByLabelText('密碼') as HTMLInputElement).value).toBe('')
  })

  it('編輯既有的:密碼留空就不送 password 欄位', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    fireEvent.click(screen.getByRole('button', { name: '編輯 staging' }))
    expect((screen.getByLabelText('密碼') as HTMLInputElement).placeholder).toBe('留空表示不變')
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'qa2' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'upsert', projectId: 'p1', revision: 1, machine: { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa2' } }) })
  })

  it('刪除送 remove', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    fireEvent.click(screen.getByRole('button', { name: '刪除 staging' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'remove', projectId: 'p1', revision: 1, id: 'm1' }) })
  })

  it('主行程回 error 就顯示在表單下方', async () => {
    const { reply } = setup()
    await screen.findByText('staging')
    reply({ kind: 'error', message: '這台電腦的鑰匙圈不可用,無法儲存密碼' })
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('網址'), { target: { value: 'https://x.test/' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect((await screen.findByRole('alert')).textContent).toBe('這台電腦的鑰匙圈不可用,無法儲存密碼')
  })

  it('密碼欄是 password 型別', async () => {
    setup()
    await screen.findByText('staging')
    expect((screen.getByLabelText('密碼') as HTMLInputElement).type).toBe('password')
  })
})
```

Run: `npx vitest run tests/test-machines-manager.test.tsx`
Expected: FAIL,找不到元件

- [ ] **Step 2: 實作元件**

```tsx
// src/renderer/components/TestMachinesManager.tsx
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { MachineView, TestMachinesRequest } from '../../shared/test-machines.js'
import './SkillsManager.css'
import './TestMachinesManager.css'

interface Form { readonly id?: string; readonly name: string; readonly url: string; readonly username: string; readonly password: string }
const EMPTY_FORM: Form = { name: '', url: '', username: '', password: '' }

export interface TestMachinesManagerProps {
  readonly api: Pick<YesChefApi, 'manageTestMachines'>
  readonly projectId: string
  readonly projectName: string
  readonly onClose: () => void
}

/** 測試機規格 §4.2。renderer 只拿得到 hasPassword,密碼欄永遠不會被回填。 */
export function TestMachinesManager({ api, projectId, projectName, onClose }: TestMachinesManagerProps): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const [revision, setRevision] = useState(0)
  const [machines, setMachines] = useState<readonly MachineView[]>([])
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (request: TestMachinesRequest, afterOk?: () => void): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await api.manageTestMachines(request)
      if (!alive.current) return
      if (response.kind === 'error') { setError(response.message); return }
      setRevision(response.revision)
      setMachines(response.machines)
      afterOk?.()
    } catch (raw) {
      if (alive.current) setError(raw instanceof Error ? raw.message : '測試機設定讀取失敗')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    void run({ action: 'list', projectId })
    return () => { alive.current = false }
  }, [projectId])

  const save = (event: React.FormEvent): void => {
    event.preventDefault()
    const machine = {
      ...(form.id === undefined ? {} : { id: form.id }),
      name: form.name, url: form.url, username: form.username,
      ...(form.password === '' ? {} : { password: form.password }),
    }
    void run({ action: 'upsert', projectId, revision, machine }, () => { setForm(EMPTY_FORM) })
  }
  const edit = (m: MachineView): void => { setForm({ id: m.id, name: m.name, url: m.url, username: m.username, password: '' }) }
  const remove = (m: MachineView): void => { void run({ action: 'remove', projectId, revision, id: m.id }) }
  const field = (key: keyof Omit<Form, 'id'>) => (event: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [key]: event.currentTarget.value }) }

  return (
    <dialog ref={dialog} className="skills-dialog test-machines-dialog" onClose={onClose}>
      <header className="skills-heading">
        <div>
          <div className="skills-eyebrow">{projectName}</div>
          <h1>測試機</h1>
          <p>agent 只能用 view_login 登入這裡設定的測試機,看不到帳密。</p>
        </div>
        <button type="button" onClick={onClose}>關閉</button>
      </header>
      <div className="skills-body">
        <ul className="test-machines-list">
          {machines.map((m) => (
            <li key={m.id}>
              <div className="test-machines-row">
                <h3>{m.name}</h3>
                <span className="test-machines-url">{m.url}</span>
                <span>{m.username}</span>
                <span className={m.hasPassword ? 'test-machines-ok' : 'test-machines-missing'}>{m.hasPassword ? '已設定' : '未設定'}</span>
              </div>
              <div className="test-machines-actions">
                <button type="button" aria-label={`編輯 ${m.name}`} onClick={() => { edit(m) }} disabled={busy}>編輯</button>
                <button type="button" aria-label={`刪除 ${m.name}`} onClick={() => { remove(m) }} disabled={busy}>刪除</button>
              </div>
            </li>
          ))}
        </ul>
        <form className="test-machines-form" onSubmit={save}>
          <h2>{form.id === undefined ? '新增測試機' : `編輯 ${form.name}`}</h2>
          <label>名稱<input value={form.name} onChange={field('name')} required /></label>
          <label>網址<input value={form.url} onChange={field('url')} placeholder="https://staging.example.com/login" required /></label>
          <label>帳號<input value={form.username} onChange={field('username')} autoComplete="off" /></label>
          <label>密碼<input type="password" value={form.password} onChange={field('password')} autoComplete="new-password"
            placeholder={form.id === undefined ? '' : '留空表示不變'} /></label>
          {error === '' ? null : <p role="alert" className="test-machines-error">{error}</p>}
          <div className="test-machines-actions">
            <button type="submit" disabled={busy}>儲存</button>
            {form.id === undefined ? null : <button type="button" onClick={() => { setForm(EMPTY_FORM) }}>取消編輯</button>}
          </div>
        </form>
      </div>
    </dialog>
  )
}
```

`getByLabelText('名稱')` 要求 `<label>` 直接包住 `<input>`,上面的寫法符合。

```css
/* src/renderer/components/TestMachinesManager.css */
.test-machines-list { list-style: none; margin: 0 0 24px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.test-machines-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 8px; background: var(--ui-raised); }
.test-machines-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; min-width: 0; font-size: 13px; color: var(--ui-muted); }
.test-machines-url { font-family: var(--ui-mono); font-size: 12px; overflow-wrap: anywhere; }
.test-machines-ok { color: var(--ui-accent); }
.test-machines-missing { color: var(--ui-warning); }
.test-machines-actions { display: flex; gap: 8px; flex-shrink: 0; }
.test-machines-form { display: flex; flex-direction: column; gap: 12px; }
.test-machines-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ui-muted); }
.test-machines-error { margin: 0; font-size: 12px; color: var(--ui-danger); }
```

配色沿用現有 token,整體視覺在 Apple design 那份規格一起處理。

- [ ] **Step 3: 接上 `App.tsx`**

- `const [testMachinesOpen, setTestMachinesOpen] = useState(false)`
- 在「授權」按鈕後面加:`<button type="button" className="panel-toggle" onClick={() => { panelGroup.current?.hideNow(); setTestMachinesOpen(true) }} disabled={projects.active === undefined}>測試機</button>`
- `dragging` 的條件加 `|| testMachinesOpen`(對話框開著時原生 view 要藏起來,跟另外三個對話框一樣)
- 在 `{skillsOpen && …}` 旁邊加:`{testMachinesOpen && projects.active !== undefined && <TestMachinesManager api={api} projectId={projects.active.id} projectName={projects.active.name} onClose={() => setTestMachinesOpen(false)} />}`

- [ ] **Step 4: 跑測試**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer tests/test-machines-manager.test.tsx
git commit -m "feat: add test machine settings dialog"
```

---

### Task 7: 實機驗收與規格同步

**Files:**
- Create: `docs/RESULTS-35-test-machines.md`
- Modify: `docs/specs/2026-09-22-test-machines-design.md`

- [ ] **Step 1: 實機驗收**

Run: `npm run dev`,照規格 §8.2 的七項做,逐項記錄。第 1 項要記 Keychain 提示的次數(第一次存密碼、重啟後第一次讀),以及重新 build 後舊密文能不能解開。

- [ ] **Step 2: 結果文件**

`docs/RESULTS-35-test-machines.md`,三段:七項驗收各 ✓ / ✗ 與實際看到的;Keychain 行為(提示次數、換 build 後的結果);已知限制(沒有就寫「無」)。用詞規則同前一份 RESULTS。

- [ ] **Step 3: 規格同步**

- 狀態改成「已實作,驗收見 docs/RESULTS-35-test-machines.md」。
- §5.2 第 5、6 步合併:「有 `submitRef` 就 `click` 它,沒有就 `press('Enter')`;兩者都會等頁面靜默」。
- §5.3 的 `view_snapshot` 那列,「實作時加一條測試釘住」改成「Chromium 的無障礙樹對密碼欄回的是遮罩後的值;用假 CDP 的單元測試驗不到這件事,由 §8.2 第 4 項在真的 Electron 裡確認」,並把 §8.1 對應那條刪掉。
- §8.3 依 Step 1 量到的結果改寫。
- 跑 `writing-tone` 的自查指令,破折號 0、粗體 0、禁用詞 0。

- [ ] **Step 4: Commit**

```bash
git add docs/RESULTS-35-test-machines.md docs/specs/2026-09-22-test-machines-design.md
git commit -m "docs: record test machine acceptance and sync spec"
```
