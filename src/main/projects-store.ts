/**
 * `<userData>/yeschef-projects.json` 的讀寫(規格 §4.1、§6)。
 *
 * 寫:先寫 `.tmp`,再把主檔輪到 `.bak.0`(舊的 `.bak.0` 輪到 `.bak.1`),最後 rename `.tmp`
 * 成主檔。任一步失敗,前面的檔案都還在,不會出現半份主檔。
 * 讀:依序試主檔、`.bak.0`、`.bak.1`,每一份讀不出來都記一筆錯;都不行回空狀態,
 * 不刪不改任何檔。主檔的 schemaVersion 不認得時改名保留(規格 §4.1「保留原檔」),
 * 之後的 save 才不會蓋掉它。
 */
import { promises as nodeFs } from 'node:fs'
import { EMPTY_PROJECTS_STATE, PROJECTS_SCHEMA_VERSION, type ProjectsState } from '../shared/projects.js'
import { parseProjectsState, readSchemaVersion } from './projects-schema.js'
import { migrateV1 } from './projects-migrate.js'

export interface StoreFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface ProjectsStore {
  load(): Promise<ProjectsState>
  save(state: ProjectsState): Promise<void>
}

export interface ProjectsStoreDeps {
  readonly filePath: string
  readonly fs: StoreFs
  readonly logError: (error: Error) => void
}

export const nodeStoreFs: StoreFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, data) => nodeFs.writeFile(p, data, 'utf8'),
  rename: (from, to) => nodeFs.rename(from, to),
  exists: async (p) => {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
}

export function backupPaths(filePath: string): readonly [string, string] {
  return [`${filePath}.bak.0`, `${filePath}.bak.1`]
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createProjectsStore(deps: ProjectsStoreDeps): ProjectsStore {
  const { filePath, fs, logError } = deps
  const [bak0, bak1] = backupPaths(filePath)
  const tmp = `${filePath}.tmp`

  /** 認得的版本:現行版本直接讀;版本 1 轉換後讀。其餘照 D 的規則改名保留。 */
  const KNOWN_VERSIONS: readonly number[] = [1, PROJECTS_SCHEMA_VERSION]

  async function readCandidate(
    path: string,
    isMain: boolean,
  ): Promise<{ readonly state: ProjectsState; readonly migrated: boolean } | null | 'unknown-version'> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(path))
    } catch (cause) {
      logError(new Error(`讀取 ${path} 失敗:${messageOf(cause)}`))
      return null
    }
    const version = readSchemaVersion(raw)
    if (isMain && version !== undefined && !KNOWN_VERSIONS.includes(version)) {
      const kept = `${filePath}.schema-${version}`
      // 改名失敗(唯讀的 userData、權限不足)只記錯誤:狀態檔的問題不該讓 app 起不來。
      // 原檔留在原位也還安全,後續 save 會先把它輪到 .bak.0 再寫新的主檔。
      try {
        await fs.rename(filePath, kept)
        logError(new Error(`${filePath} 的 schemaVersion ${version} 不認得,已改名為 ${kept} 保留,改用空狀態`))
      } catch (cause) {
        logError(new Error(
          `${filePath} 的 schemaVersion ${version} 不認得,改名為 ${kept} 失敗:${messageOf(cause)};原檔未動,改用空狀態`
        ))
      }
      return 'unknown-version'
    }
    const migrated = version === 1
    const parsed = parseProjectsState(migrated ? migrateV1(raw) : raw)
    if (parsed === null) {
      logError(new Error(`讀取 ${path} 失敗:內容不符合 schemaVersion ${PROJECTS_SCHEMA_VERSION}`))
      return null
    }
    return { state: parsed, migrated }
  }

  async function load(): Promise<ProjectsState> {
    for (const path of [filePath, bak0, bak1]) {
      if (!(await fs.exists(path))) continue
      const result = await readCandidate(path, path === filePath)
      if (result === 'unknown-version') return EMPTY_PROJECTS_STATE
      if (result === null) continue
      // 規格 §5:版本 1 轉換後寫回,下次啟動就直接是版本 2。寫失敗只記錯,狀態照用。
      if (result.migrated) {
        try {
          await save(result.state)
        } catch (cause) {
          logError(new Error(`寫回版本 ${PROJECTS_SCHEMA_VERSION} 的狀態檔失敗:${messageOf(cause)}`))
        }
      }
      return result.state
    }
    return EMPTY_PROJECTS_STATE
  }

  async function writeAtomically(state: ProjectsState): Promise<void> {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2))
    if (await fs.exists(bak0)) await fs.rename(bak0, bak1)
    if (await fs.exists(filePath)) await fs.rename(filePath, bak0)
    await fs.rename(tmp, filePath)
  }

  // save 排成一條鏈:兩次 save 同時進來時輪替步驟不能交錯。
  let queue: Promise<void> = Promise.resolve()
  function save(state: ProjectsState): Promise<void> {
    const run = queue.then(() => writeAtomically(state))
    queue = run.catch(() => undefined)
    return run
  }

  return { load, save }
}
