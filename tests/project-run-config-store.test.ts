import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRunConfigSchema } from '../src/shared/project-run.js'
import { createProjectRunConfigStore } from '../src/main/project-run/config-store.js'

const CONFIG = {
  version: 1,
  command: 'npm run dev -- --port {port}',
  cwd: '.',
  port: 5173,
  url: 'http://127.0.0.1:{port}/',
  readyPath: '/',
  env: {},
  portStrategy: 'placeholder',
  watch: { enabled: false, include: ['**/*.ts'], exclude: [] },
  openInBrowser: true,
} as const

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('ProjectRunConfigSchema', () => {
  it('accepts valid config and rejects invalid port, escaping cwd, and placeholder without token', () => {
    expect(ProjectRunConfigSchema.safeParse(CONFIG).success).toBe(true)
    expect(ProjectRunConfigSchema.safeParse({ ...CONFIG, port: 0 }).success).toBe(false)
    expect(ProjectRunConfigSchema.safeParse({ ...CONFIG, cwd: '../outside' }).success).toBe(false)
    expect(ProjectRunConfigSchema.safeParse({ ...CONFIG, command: 'npm run dev' }).success).toBe(false)
  })
})

describe('createProjectRunConfigStore', () => {
  it('原子保存、讀取與移除每個專案的設定', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'project-run-config-'))
    roots.push(dir)
    const store = createProjectRunConfigStore(dir)
    await store.save('project-a', CONFIG)
    await expect(store.load('project-a')).resolves.toEqual(CONFIG)
    expect(JSON.parse(await readFile(join(dir, 'project-a.json'), 'utf8'))).toEqual(CONFIG)
    await store.removeProject('project-a')
    await expect(store.load('project-a')).resolves.toBeUndefined()
  })

  it('拒絕無效設定且不寫入檔案', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'project-run-config-invalid-'))
    roots.push(dir)
    const store = createProjectRunConfigStore(dir)
    await expect(store.save('project-a', { ...CONFIG, port: -1 })).rejects.toThrow()
    await expect(store.load('project-a')).resolves.toBeUndefined()
  })
})
