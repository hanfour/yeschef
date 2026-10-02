import type { ChefTaskPurpose } from '../../shared/chef.js'
import type { ChefService } from '../chef/service.js'
import { MSG } from './messages.js'

/**
 * 執行次數上限。群組開的一般任務 8 次；錯誤收集的安裝任務會拆成安裝、測試、本機實證、開 PR、驗收等
 * 約 7 個工作單位，實機驗收時 8 次用完、總驗收沒跑到，所以給 12 次。
 */
const MAX_EXECUTIONS: Readonly<Record<ChefTaskPurpose | 'default', number>> = { default: 8, 'error-intake-setup': 12, 'error-fix': 20 }

export type StartChefTaskResult =
  | { readonly kind: 'ok'; readonly taskId: string }
  | { readonly kind: 'error'; readonly message: string }

export async function startChefTask(
  chef: ChefService | undefined,
  projectId: string,
  goal: string,
  purpose?: ChefTaskPurpose,
  beforeRun?: (taskId: string) => Promise<void>,
): Promise<StartChefTaskResult> {
  if (chef === undefined) return { kind: 'error', message: MSG.noChef }
  try {
    const inventory = await chef.handle({ action: 'get' })
    if (inventory.kind !== 'state') return { kind: 'error', message: MSG.startFailed(inventory.message) }
    const allowed = inventory.state.models.map((model) => model.key)
    if (allowed.length === 0) return { kind: 'error', message: MSG.noModels }
    const policy = { mode: 'auto' as const, allowed, maxExecutions: MAX_EXECUTIONS[purpose ?? 'default'], deadlineMinutes: 120 }
    const taskId = beforeRun === undefined
      ? await chef.start(projectId, goal, policy, purpose)
      : await chef.start(projectId, goal, policy, purpose, beforeRun)
    return { kind: 'ok', taskId }
  } catch (error) {
    return { kind: 'error', message: MSG.startFailed(error instanceof Error ? error.message : '') }
  }
}
