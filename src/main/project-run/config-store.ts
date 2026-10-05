import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectRunConfigSchema, type ProjectRunConfig } from '../../shared/project-run.js'

export interface ProjectRunConfigStore {
  load(projectId: string): Promise<ProjectRunConfig | undefined>
  save(projectId: string, config: unknown): Promise<void>
  removeProject(projectId: string): Promise<void>
}

export interface ProjectRunConfigFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options: { mode: number }): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  rm(path: string, options: { force: true }): Promise<unknown>
}

export interface ProjectRunConfigStoreDeps {
  readonly dir: string
  readonly fs?: ProjectRunConfigFs
  readonly newId?: () => string
}

const NODE_FS: ProjectRunConfigFs = { mkdir, readFile, writeFile, rename, rm }

function validProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('專案識別碼格式不正確')
}

export function createProjectRunConfigStore(deps: string | ProjectRunConfigStoreDeps): ProjectRunConfigStore {
  const options: ProjectRunConfigStoreDeps = typeof deps === 'string' ? { dir: deps } : deps
  const fs = options.fs ?? NODE_FS
  const newId = options.newId ?? randomUUID
  const pathOf = (projectId: string): string => {
    validProjectId(projectId)
    return join(options.dir, `${projectId}.json`)
  }
  const save = async (projectId: string, raw: unknown): Promise<void> => {
    const config = ProjectRunConfigSchema.parse(raw)
    await fs.mkdir(options.dir, { recursive: true, mode: 0o700 })
    const path = pathOf(projectId)
    const temporary = `${path}.${newId()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 })
      await fs.rename(temporary, path)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  return {
    async load(projectId) {
      const path = pathOf(projectId)
      let text: string
      try {
        text = await fs.readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      return ProjectRunConfigSchema.parse(JSON.parse(text))
    },
    save,
    async removeProject(projectId) {
      await fs.rm(pathOf(projectId), { force: true })
    },
  }
}
