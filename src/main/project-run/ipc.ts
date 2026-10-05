import { ProjectRunRequestSchema, type ProjectRunConfig, type ProjectRunResponse } from '../../shared/project-run.js'
import type { ProjectRunConfigStore } from './config-store.js'
import type { ProjectRunRunner } from './runner.js'

export interface ProjectRunIpcDeps {
  readonly isTrustedSender: (sender: unknown) => boolean
  readonly projectRoot: (projectId: string) => string | undefined
  readonly projectName: (projectId: string) => string | undefined
  readonly configStore: ProjectRunConfigStore
  readonly runner: ProjectRunRunner
  readonly discover: (rootPath: string) => Promise<readonly { readonly command: string; readonly cwd: string; readonly port: number | null; readonly source: string }[]>
  readonly readLog: (projectId: string) => Promise<string>
  readonly logPath: (projectId: string) => string
  readonly openInBrowser: (projectId: string) => Promise<void>
  readonly refreshBrowser: (projectId: string) => Promise<void>
  readonly openLog: (path: string) => Promise<string>
  readonly logError: (error: Error) => void
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function visibleError(error: unknown): string {
  const message = toError(error).message
  return message.includes('port') || message.includes('連接埠') || message.includes('設定')
    ? message
    : '專案執行操作失敗，請檢查紀錄'
}

export function createProjectRunIpcHandler(deps: ProjectRunIpcDeps) {
  const fail = (message: string): ProjectRunResponse => ({ kind: 'error', message })

  const state = async (projectId: string, config?: ProjectRunConfig): Promise<ProjectRunResponse> => {
    const root = deps.projectRoot(projectId)
    const [stored, candidates, diskLog] = await Promise.all([
      config === undefined ? deps.configStore.load(projectId) : Promise.resolve(config),
      root === undefined ? Promise.resolve([]) : deps.discover(root),
      deps.readLog(projectId),
    ])
    return {
      kind: 'state',
      ...(stored === undefined ? {} : { config: stored }),
      candidates: [...candidates],
      snapshot: deps.runner.snapshot(projectId),
      logs: (deps.runner.logs(projectId).length > 0 ? deps.runner.logs(projectId) : diskLog.split(/\r?\n/).filter(Boolean)).slice(-2000),
      logPath: deps.logPath(projectId),
    }
  }

  return async (event: { readonly sender: unknown }, raw: unknown): Promise<ProjectRunResponse> => {
    if (!deps.isTrustedSender(event.sender)) return fail('不接受此來源的專案執行請求')
    const request = ProjectRunRequestSchema.safeParse(raw)
    if (!request.success) return fail('專案執行請求格式不正確')
    const { projectId } = request.data
    try {
      switch (request.data.action) {
        case 'get': return await state(projectId)
        case 'save':
          if (deps.projectRoot(projectId) === undefined) return fail('找不到這個專案')
          await deps.configStore.save(projectId, request.data.config)
          return await state(projectId, request.data.config)
        case 'start': {
          const root = deps.projectRoot(projectId)
          if (root === undefined) return fail('找不到這個專案')
          const config = await deps.configStore.load(projectId)
          if (config === undefined) return fail('請先設定服務啟動方式')
          const projectName = deps.projectName(projectId)
          await deps.runner.start(projectId, root, config, {
            useFreePort: request.data.useFreePort ?? false,
            ...(projectName === undefined ? {} : { projectName }),
          })
          return await state(projectId, config)
        }
        case 'stop':
          await deps.runner.stop(projectId)
          return await state(projectId)
        case 'restart':
          await deps.runner.restart(projectId)
          return await state(projectId)
        case 'open':
          await deps.openInBrowser(projectId)
          return await state(projectId)
        case 'refresh':
          await deps.refreshBrowser(projectId)
          deps.runner.acknowledgeRestart(projectId)
          return await state(projectId)
        case 'openLog': {
          const message = await deps.openLog(deps.logPath(projectId))
          return message === '' ? await state(projectId) : fail(message)
        }
      }
    } catch (error) {
      deps.logError(toError(error))
      return fail(visibleError(error))
    }
  }
}
