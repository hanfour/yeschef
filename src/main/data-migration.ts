import { join } from 'node:path'

/** `<userData>/yeschef-projects.json` stores the project registry. */
export const PROJECTS_FILE = 'yeschef-projects.json'

export interface DirectoryMigration {
  readonly from: string
  readonly to: string
}

export interface DirectoryMigrationFs {
  exists(path: string): boolean
  rename(from: string, to: string): void
}

export interface DirectoryMigrationResult {
  readonly moved: readonly DirectoryMigration[]
  readonly conflicts: readonly DirectoryMigration[]
  readonly failures: readonly Error[]
}

export function migrateLegacyDirectories(
  migrations: readonly DirectoryMigration[],
  fs: DirectoryMigrationFs,
): DirectoryMigrationResult {
  const moved: DirectoryMigration[] = []
  const conflicts: DirectoryMigration[] = []
  const failures: Error[] = []
  for (const migration of migrations) {
    if (!fs.exists(migration.from)) continue
    if (fs.exists(migration.to)) { conflicts.push(migration); continue }
    try {
      fs.rename(migration.from, migration.to)
      moved.push(migration)
    } catch (cause) {
      failures.push(new Error(`無法搬移資料目錄 ${migration.from}`, { cause }))
    }
  }
  return { moved, conflicts, failures }
}

export function migrateYesChefData(
  appDataPath: string,
  homePath: string,
  fs: DirectoryMigrationFs,
): DirectoryMigrationResult {
  const userDataPath = join(appDataPath, 'yeschef')
  const userData = migrateLegacyDirectories([{ from: join(appDataPath, 'sidepane'), to: userDataPath }], fs)
  const contents = userData.moved.length === 0 ? emptyResult() : migrateLegacyDirectories([
    { from: join(userDataPath, 'sidepane-projects.json'), to: join(userDataPath, PROJECTS_FILE) },
    // 主檔讀不出來時改讀這兩份備份，名稱要跟主檔一起換。
    { from: join(userDataPath, 'sidepane-projects.json.bak.0'), to: join(userDataPath, `${PROJECTS_FILE}.bak.0`) },
    { from: join(userDataPath, 'sidepane-projects.json.bak.1'), to: join(userDataPath, `${PROJECTS_FILE}.bak.1`) },
    { from: join(userDataPath, 'sidepane-group'), to: join(userDataPath, 'yeschef-group') },
    { from: join(userDataPath, 'sidepane-mail'), to: join(userDataPath, 'yeschef-mail') },
  ], fs)
  const home = migrateLegacyDirectories([{ from: join(homePath, '.sidepane'), to: join(homePath, '.yeschef') }], fs)
  return {
    moved: [...userData.moved, ...contents.moved, ...home.moved],
    conflicts: [...userData.conflicts, ...contents.conflicts, ...home.conflicts],
    failures: [...userData.failures, ...contents.failures, ...home.failures],
  }
}

function emptyResult(): DirectoryMigrationResult {
  return { moved: [], conflicts: [], failures: [] }
}
