import { basename } from 'node:path'
import type { ErrorIntakeRequest, ErrorIntakeResponse } from '../../shared/error-intake.js'
import { ERROR_FIX_PURPOSE, ERROR_INTAKE_SETUP_PURPOSE } from '../../shared/chef.js'
import type { ChefService } from '../chef/service.js'
import { startChefTask } from '../group/start-chef-task.js'
import type { ErrorIntakeService } from './service.js'
import { errorIntakeSetupGoal, validatePackageSource } from './goal.js'
import { buildErrorFixGoal } from './pull.js'

export interface ErrorIntakeActivationDeps {
  readonly service: ErrorIntakeService
  readonly chef?: ChefService
  readonly rootPathOf: (projectId: string) => string | undefined
  readonly writeClipboard: (text: string) => void
  readonly logError?: (error: Error) => void
}

export function createErrorIntakeActivation(deps: ErrorIntakeActivationDeps) {
  let activationTail: Promise<void> = Promise.resolve()
  const enqueueEnable = (request: Extract<ErrorIntakeRequest, { action: 'enable' }>) => {
    const operation = activationTail.then(() => enableProject(request), () => enableProject(request))
      .catch(() => failure('錯誤收集啟用失敗'))
    activationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  const project = async (projectId: string): Promise<ErrorIntakeResponse> => {
    try {
      const root = deps.rootPathOf(projectId)
      if (root === undefined) return failure('找不到目前專案')
      const folderName = basename(root)
      const state = await deps.service.projectState(projectId, folderName)
      return { kind: 'project', projectId, folderName, defaultProjectCode: state.defaultProjectCode,
        enabled: state.enabled, projectCode: state.projectCode,
        projectCodeLocked: state.projectCodeLocked, databaseReady: state.databaseReady }
    } catch { return failure('目前專案設定讀取失敗') }
  }

  const enableProject = async (request: Extract<ErrorIntakeRequest, { action: 'enable' }>): Promise<ErrorIntakeResponse> => {
    if (!request.acknowledged) return failure('請先確認錯誤內容會送到模型供應商')
    let packageSource: string
    try { packageSource = validatePackageSource(request.packageSource) } catch (error) { return failure(messageOf(error)) }
    const root = deps.rootPathOf(request.projectId)
    if (root === undefined) return failure('找不到目前專案')
    const state = await deps.service.projectState(request.projectId, basename(root))
    if (!state.databaseReady) return failure('請先初始化錯誤資料庫並確認版本正確')
    if (state.enabled) return failure('這個專案已啟用錯誤收集')
    const settings = await deps.service.handle({ action: 'get' })
    if (settings.kind !== 'settings') return failure('錯誤收集設定目前無法讀取')
    try {
      await deps.service.ensureProjectWriter(request.projectId, request.projectCode)
      await deps.service.markProjectEnabled(request.projectId, request.projectCode, packageSource)
    } catch (error) { return failure(messageOf(error)) }
    return startSetupTask(deps, request, packageSource, settings.settings.packageSource)
  }

  const copyConnection = async (projectId: string): Promise<ErrorIntakeResponse> => {
    try {
      if (!(await deps.service.isReady())) return failure('錯誤資料庫目前不可用，請先確認資料庫連線與版本')
      if (await deps.service.enabledProjectCode(projectId) === undefined) return failure('這個專案尚未啟用錯誤收集')
      const value = await deps.service.writerConnectionUrl(projectId)
      if (value === undefined) return failure('找不到這個專案的連線設定')
      deps.writeClipboard(value)
      return { kind: 'copied', projectId }
    } catch { return failure('連線字串複製失敗') }
  }

  return {
    project,
    enable: enqueueEnable,
    copyConnection,
    handle(request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> {
      if (request.action === 'project') return project(request.projectId)
      if (request.action === 'enable') return enqueueEnable(request)
      if (request.action === 'copy-connection') return copyConnection(request.projectId)
      if (request.action === 'pull-list') return listPullErrors(deps, request.projectId, request.environment)
      if (request.action === 'set-group-status') return setGroupStatus(deps, request.projectId, request.groupId, request.status)
      if (request.action === 'start-fix') return startFixTask(deps, request.projectId, request.groupIds)
      return Promise.resolve(failure('錯誤收集啟用請求格式不正確'))
    },
  }
}

async function listPullErrors(
  deps: ErrorIntakeActivationDeps,
  projectId: string,
  environment: Extract<ErrorIntakeRequest, { action: 'pull-list' }>['environment'],
): Promise<ErrorIntakeResponse> {
  try {
    const result = await deps.service.listPullErrors(projectId, environment)
    return { kind: 'pull-list', environments: [...result.environments], selectedEnvironment: result.selectedEnvironment,
      newGroups: [...result.newGroups], inProgressGroups: [...result.inProgressGroups] }
  }
  catch (error) { return failure(messageOf(error)) }
}

async function setGroupStatus(
  deps: ErrorIntakeActivationDeps,
  projectId: string,
  groupId: string,
  status: Extract<ErrorIntakeRequest, { action: 'set-group-status' }>['status'],
): Promise<ErrorIntakeResponse> {
  try {
    await deps.service.updateGroupStatus(projectId, groupId, status)
    return { kind: 'group-status-updated' }
  } catch (error) { return failure(messageOf(error)) }
}

async function startFixTask(deps: ErrorIntakeActivationDeps, projectId: string, groupIds: readonly string[]): Promise<ErrorIntakeResponse> {
  if (deps.rootPathOf(projectId) === undefined) return failure('找不到目前專案')
  try {
    const groups = await deps.service.getErrorFixData(projectId, groupIds)
    const result = await startChefTask(deps.chef, projectId, buildErrorFixGoal(groups), ERROR_FIX_PURPOSE,
      taskId => deps.service.markErrorGroupsInProgress(projectId, groupIds, taskId))
    if (result.kind === 'error') return failure(result.message)
    return { kind: 'fix-started', taskId: result.taskId }
  } catch (error) { return failure(messageOf(error)) }
}

async function startSetupTask(
  deps: ErrorIntakeActivationDeps,
  request: Extract<ErrorIntakeRequest, { action: 'enable' }>,
  packageSource: string,
  previousPackageSource: string,
): Promise<ErrorIntakeResponse> {
  const result = await startChefTask(
    deps.chef, request.projectId, errorIntakeSetupGoal(request.projectCode, packageSource), ERROR_INTAKE_SETUP_PURPOSE,
  )
  if (result.kind === 'error') {
    await deps.service.rollbackProjectEnable(request.projectId, previousPackageSource).catch(() => {
      deps.logError?.(new Error('錯誤收集啟用狀態回復失敗'))
    })
    return failure(result.message)
  }
  return { kind: 'enabled', projectId: request.projectId, projectCode: request.projectCode, taskId: result.taskId }
}

function failure(message: string): ErrorIntakeResponse {
  return { kind: 'error', message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '錯誤收集啟用失敗'
}
