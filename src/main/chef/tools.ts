import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { CHEF_INTERNAL_TOOL_NAMES, DelegateSchema, ChefReportSchema, ERROR_INTAKE_SETUP_PURPOSE } from '../../shared/chef.js'
import { ERROR_INTAKE_SETUP_TOOL_NAMES } from '../../shared/error-intake.js'
import { SayToGroupSchema } from '../../shared/group.js'
import type { ChefService } from './service.js'
import type { CodexDynamicTool, CodexToolOutcome } from '../codex/client.js'
import { chefToolPolicy } from './tool-policy.js'
import { checkErrorIntake, configureErrorIntakeEnv, type ErrorIntakeToolContext } from '../error-intake/tools.js'
export const CHEF_TOOL_NAMES = CHEF_INTERNAL_TOOL_NAMES
export const ERROR_INTAKE_TOOL_NAMES = ERROR_INTAKE_SETUP_TOOL_NAMES
type ChefToolName = keyof typeof descriptions
const descriptions = {
  delegate_task: '把明確的子工作交給 YesChef 主廚選模型執行。只排程，等你結束本回合後才執行；不可等待或輪詢子任務。所有外部 agent 委派都用這個工具。',
  task_progress: '取得目前主廚任務的真實工作者、工作單位與工具紀錄，供交接／驗收與 report_result 引用工具 ID。使用者直接 @ 給其他參與者且已送達的訊息已由對方處理，只作背景資訊，不要另開單位代辦或重做。',
  report_result: '主廚或驗收者回報本輪結果。完成時必須引用實作／測試工作者的成功工具結果，不能以摘要冒充驗證。有 <ui-check> 時，uiFindings 必須逐項回報編號、處理方式與原因。仍有排程子任務時，先結束本回合讓它們執行。',
  say_to_group: '在專案群組裡對人與其他工作者說一句話。用在需要讓大家知道的事:你打算怎麼做、遇到什麼取捨、需要誰配合。不用在逐步進度上,那些會自動出現。',
  configure_error_intake_env: '把錯誤收集環境變數寫入專案內已被 git 忽略的設定檔。每次呼叫都需要使用者批准。',
  check_error_intake: '查詢這個專案最近新增或更新的錯誤群。',
}
const schemas = {
  delegate_task: DelegateSchema,
  task_progress: z.object({}).strict(),
  report_result: ChefReportSchema,
  say_to_group: SayToGroupSchema,
  configure_error_intake_env: z.object({ envFile: z.string().min(1).max(1024) }).strict(),
  check_error_intake: z.object({ sinceMinutes: z.number().int().min(1).max(120) }).strict(),
}

export interface ChefToolOptions {
  readonly errorIntake?: ErrorIntakeToolContext
  readonly approve?: (toolName: string, input: unknown, toolUseId: string) => Promise<boolean>
}

export function createChefTools(service: ChefService, workerId: string, options: ChefToolOptions = {}) {
  let approvalSequence = 0
  const call = async (name: string, args: unknown, callId?: string): Promise<CodexToolOutcome> => {
    try {
      if (!service.runnable(workerId)) throw Error('這個工作者已停止或不是目前執行者')
      if (isErrorIntakeTool(name)) return callErrorIntake(service, workerId, name, args, callId, options, () => ++approvalSequence)
      let result: unknown
      if (name === 'delegate_task') result = await service.delegate(workerId, args)
      else if (name === 'task_progress') { schemas.task_progress.parse(args); result = await service.progress(workerId) }
      else if (name === 'report_result') result = await service.report(workerId, args)
      else if (name === 'say_to_group') result = await service.sayToGroup(workerId, schemas.say_to_group.parse(args))
      else throw Error('不支援的主廚工具')
      return { ok: true, text: JSON.stringify(result) }
    } catch (error) { return { ok: false, text: error instanceof Error ? error.message : '主廚工具失敗' } }
  }
  const baseNames: readonly ChefToolName[] = service.worker(workerId)?.role === 'worker'
    ? ['task_progress', 'say_to_group']
    : CHEF_TOOL_NAMES
  const setupNames: readonly ChefToolName[] = service.worker(workerId)?.purpose === ERROR_INTAKE_SETUP_PURPOSE && options.errorIntake !== undefined
    ? ERROR_INTAKE_TOOL_NAMES
    : []
  const names = [...baseNames, ...setupNames]
  const sdkTools = names.map(name => tool(name, descriptions[name], schemas[name].shape, async args => {
    const result = await call(name, args)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.ok ? {} : { isError: true }) }
  }))
  const server = createSdkMcpServer({ name: 'chef', version: '1.0.0', tools: sdkTools })
  const specs: CodexDynamicTool[] = names.map(name => ({ type: 'function', name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) as Record<string, unknown> }))
  return { server, specs, call, names, sdkTools }
}

function isErrorIntakeTool(name: string): name is typeof ERROR_INTAKE_TOOL_NAMES[number] {
  return ERROR_INTAKE_TOOL_NAMES.some((toolName) => toolName === name)
}

async function callErrorIntake(
  service: ChefService,
  workerId: string,
  name: typeof ERROR_INTAKE_TOOL_NAMES[number],
  raw: unknown,
  callId: string | undefined,
  options: ChefToolOptions,
  nextApprovalId: () => number,
): Promise<CodexToolOutcome> {
  if (service.worker(workerId)?.purpose !== ERROR_INTAKE_SETUP_PURPOSE) return { ok: false, text: '這個主廚任務沒有錯誤收集設定用途' }
  const context = options.errorIntake
  if (context === undefined) return { ok: false, text: '錯誤收集工具目前不可用' }
  const parsed = schemas[name].safeParse(raw)
  if (!parsed.success) return { ok: false, text: `工具參數格式不正確：${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}` }
  if (chefToolPolicy(name) === 'ask' && options.approve !== undefined) {
    const toolUseId = callId ?? `chef-error-intake-${workerId}-${nextApprovalId()}`
    if (!await options.approve(name, parsed.data, toolUseId)) return { ok: false, text: '使用者未批准這次環境變數寫入' }
  }
  const result = name === 'configure_error_intake_env'
    ? await configureErrorIntakeEnv(context, (parsed.data as { readonly envFile: string }).envFile)
    : await checkErrorIntake(context, (parsed.data as { readonly sinceMinutes: number }).sinceMinutes)
  return result
}
