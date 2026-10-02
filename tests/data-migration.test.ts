import { describe, expect, it } from 'vitest'
import { migrateLegacyDirectories, migrateYesChefData, type DirectoryMigrationFs } from '../src/main/data-migration.js'

function fakeFs(initial: readonly string[], failRename = false): DirectoryMigrationFs & { readonly paths: Set<string> } {
  const paths = new Set(initial)
  return {
    paths,
    exists: (path) => paths.has(path),
    rename: (from, to) => {
      if (failRename) throw new Error('rename failed')
      if (!paths.has(from) || paths.has(to)) throw new Error('invalid rename')
      paths.delete(from)
      paths.add(to)
    },
  }
}

const PATHS = [{ from: '/appData/sidepane', to: '/appData/yeschef' }] as const

describe('migrateLegacyDirectories', () => {
  it('只有舊目錄時整個 rename 到新路徑', () => {
    const fs = fakeFs(['/appData/sidepane'])
    expect(migrateLegacyDirectories(PATHS, fs)).toEqual({ moved: PATHS, conflicts: [], failures: [] })
    expect([...fs.paths]).toEqual(['/appData/yeschef'])
  })

  it('新舊目錄都存在時保留兩者並回報衝突', () => {
    const fs = fakeFs(['/appData/sidepane', '/appData/yeschef'])
    expect(migrateLegacyDirectories(PATHS, fs)).toEqual({ moved: [], conflicts: PATHS, failures: [] })
    expect([...fs.paths].sort()).toEqual(['/appData/sidepane', '/appData/yeschef'])
  })

  it('兩個目錄都不存在時不做事', () => {
    expect(migrateLegacyDirectories(PATHS, fakeFs([]))).toEqual({ moved: [], conflicts: [], failures: [] })
  })

  it('rename 失敗時保留舊路徑並回傳錯誤', () => {
    const fs = fakeFs(['/appData/sidepane'], true)
    const result = migrateLegacyDirectories(PATHS, fs)
    expect(result.moved).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.failures[0]?.cause).toEqual(new Error('rename failed'))
    expect([...fs.paths]).toEqual(['/appData/sidepane'])
  })

  it('啟動路徑搬移 userData 與家目錄舊資料夾', () => {
    const fs = fakeFs([
      '/appData/sidepane', '/appData/yeschef/sidepane-projects.json', '/appData/yeschef/sidepane-projects.json.bak.0',
      '/appData/yeschef/sidepane-projects.json.bak.1', '/appData/yeschef/sidepane-group', '/appData/yeschef/sidepane-mail', '/home/.sidepane',
    ])
    const result = migrateYesChefData('/appData', '/home', fs)
    expect(result.moved).toContainEqual({ from: '/appData/sidepane', to: '/appData/yeschef' })
    expect(result.moved).toContainEqual({ from: '/appData/yeschef/sidepane-projects.json', to: '/appData/yeschef/yeschef-projects.json' })
    expect(result.moved).toContainEqual({ from: '/appData/yeschef/sidepane-group', to: '/appData/yeschef/yeschef-group' })
    expect(result.moved).toContainEqual({ from: '/home/.sidepane', to: '/home/.yeschef' })
    expect([...fs.paths].sort()).toEqual([
      '/appData/yeschef', '/appData/yeschef/yeschef-group', '/appData/yeschef/yeschef-mail', '/appData/yeschef/yeschef-projects.json',
      '/appData/yeschef/yeschef-projects.json.bak.0', '/appData/yeschef/yeschef-projects.json.bak.1', '/home/.yeschef',
    ])
  })
})
