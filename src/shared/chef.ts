import { z } from 'zod'
import { providerSchema } from './projects.js'

export const CHEF_INTERNAL_TOOL_NAMES = ['delegate_task', 'task_progress', 'report_result', 'say_to_group'] as const
export const ERROR_INTAKE_SETUP_PURPOSE = 'error-intake-setup' as const
export const ERROR_FIX_PURPOSE = 'error-fix' as const
export const CHEF_TASK_PURPOSES = [ERROR_INTAKE_SETUP_PURPOSE, ERROR_FIX_PURPOSE] as const
export type ChefTaskPurpose = (typeof CHEF_TASK_PURPOSES)[number]

/** Claude MCP 帶前綴,Codex dynamic tool 使用裸名;兩者都是同一組主廚控制工具。 */
export function isChefInternalTool(name: string): boolean {
  return CHEF_INTERNAL_TOOL_NAMES.some((tool) => name === tool || name === `mcp__chef__${tool}`)
}

export const CHEF_CHANNEL = 'chef:manage'
export const ChefReasoningEffortOptionSchema = z.object({ reasoningEffort: z.string(), description: z.string() })
export const ChefModelSchema = z.object({ key: z.string(), provider: providerSchema, model: z.string(), label: z.string(), description: z.string(), recommended: z.boolean(), supportedReasoningEfforts: z.array(ChefReasoningEffortOptionSchema).optional(), defaultReasoningEffort: z.string().optional() })
export type ChefModel = z.infer<typeof ChefModelSchema>
export const ChefPolicySchema = z.object({ mode: z.enum(['auto', 'preferred', 'pinned']), allowed: z.array(z.string()).min(1).max(100), preferred: z.string().optional(), maxExecutions: z.number().int().min(1).max(20), deadlineMinutes: z.number().int().min(1).max(240) })
export type ChefPolicy = z.infer<typeof ChefPolicySchema>
export const DelegateSchema = z.object({ title: z.string().min(1).max(100), goal: z.string().min(1).max(8000), kind: z.enum(['code', 'test', 'analysis', 'docs', 'review']) }).strict()
export type DelegateRequest = z.infer<typeof DelegateSchema>
export const ChefUnitSchema = DelegateSchema.extend({ id: z.string(), parentId: z.string().nullable(), status: z.enum(['queued', 'running', 'done', 'blocked']), retryAfter: z.number().optional() })
export const ChefAttemptSchema = z.object({ id: z.string(), unitId: z.string(), workerId: z.string(), provider: providerSchema, model: z.string(), actualModel: z.string().optional(), reasoningEffort: z.string().optional(), sessionId: z.string().optional(), status: z.enum(['running', 'stopping', 'done', 'failed', 'blocked']), failureKind: z.enum(['model-unavailable']).optional(), startedAt: z.number(), endedAt: z.number().optional(), reason: z.string(), events: z.array(z.unknown()), costUsd: z.number().optional(), shutdownConfirmed: z.boolean().optional(), pendingTools: z.array(z.string()), backgroundWork: z.boolean(), backgroundShells: z.array(z.string()).optional(), denied: z.boolean(), deniedTimedOut: z.boolean().default(false), awaitingApproval: z.boolean().default(false) })
export const ChefUiCheckFindingSchema = z.object({ id: z.string().regex(/^F[1-9]\d*$/), stableKey: z.string().regex(/^[a-f0-9]{64}$/), ruleId: z.enum(['side-stripe', 'gradient-text', 'eyebrow-label', 'tiny-text', 'focus-removed', 'pure-black-white']), severity: z.enum(['warning', 'error']), description: z.string().max(1000), path: z.string().min(1).max(2000), line: z.number().int().min(1), snippet: z.string().max(500) }).strict()
export const ChefUiCheckSkippedSchema = z.object({ ruleId: z.enum(['side-stripe', 'gradient-text', 'eyebrow-label', 'tiny-text', 'focus-removed', 'pure-black-white']), severity: z.enum(['warning', 'error']), description: z.string().max(1000), path: z.string().min(1).max(2000), line: z.number().int().min(1), snippet: z.string().max(500), reason: z.string().min(1).max(2000) }).strict()
export const ChefUiCheckInvalidIgnoreSchema = z.object({ ruleId: z.enum(['side-stripe', 'gradient-text', 'eyebrow-label', 'tiny-text', 'focus-removed', 'pure-black-white']), path: z.string().min(1).max(2000), line: z.number().int().min(1), snippet: z.string().max(500) }).strict()
export const ChefUiFindingIdentitySchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().regex(/^F[1-9]\d*$/) }).strict()
export const ChefUiCheckSchema = z.object({ files: z.array(z.string().min(1).max(2000)), findings: z.array(ChefUiCheckFindingSchema), skipped: z.array(ChefUiCheckSkippedSchema).optional(), invalidIgnores: z.array(ChefUiCheckInvalidIgnoreSchema).optional(), identities: z.array(ChefUiFindingIdentitySchema) }).strict()
export const ChefUiFindingReportSchema = z.object({ id: z.string().regex(/^F[1-9]\d*$/), resolution: z.enum(['fixed', 'kept']), reason: z.string().max(2000) }).strict()
export const ChefReportSchema = z.object({ outcome: z.enum(['completed', 'blocked']), summary: z.string().min(1).max(4000), checks: z.array(z.object({ workerId: z.string(), toolUseId: z.string() })).max(50), uiFindings: z.array(ChefUiFindingReportSchema).max(500).optional() }).strict()
export const ChefTaskSchema = z.object({ id: z.string(), projectId: z.string(), cwd: z.string(), goal: z.string(), purpose: z.enum(CHEF_TASK_PURPOSES).optional(), errorFixWrittenFor: z.string().optional(), followups: z.array(z.string()).default([]), policy: ChefPolicySchema, status: z.enum(['queued', 'running', 'stopping', 'completed', 'blocked', 'cancelled']), createdAt: z.number(), deadlineAt: z.number(), units: z.array(ChefUnitSchema), attempts: z.array(ChefAttemptSchema), reason: z.string(), cancelRequested: z.boolean(), needsReconciliation: z.boolean(), uiCheck: ChefUiCheckSchema.optional(), report: ChefReportSchema.extend({ unitId: z.string() }).optional() })
export type ChefTask = z.infer<typeof ChefTaskSchema>
export type ChefAttempt = z.infer<typeof ChefAttemptSchema>
export const ChefUnavailableModelSchema = z.object({ key: z.string(), expiresAt: z.number().int().nonnegative() })
export type ChefUnavailableModel = z.infer<typeof ChefUnavailableModelSchema>
export const ChefStateSchema = z.object({ tasks: z.array(ChefTaskSchema), models: z.array(ChefModelSchema), unavailableModels: z.array(ChefUnavailableModelSchema), notices: z.array(z.string()) })
export const ChefRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), refreshModels: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('start'), projectId: z.string(), goal: z.string().min(1).max(20000), policy: ChefPolicySchema }).strict(),
  z.object({ action: z.literal('cancel'), taskId: z.string() }).strict(),
  z.object({ action: z.literal('resume'), taskId: z.string(), reconciled: z.boolean(), message: z.string().max(8000).optional() }).strict(),
])
export type ChefRequest = z.infer<typeof ChefRequestSchema>
export const ChefResponseSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('state'), state: ChefStateSchema }), z.object({ kind: z.literal('error'), message: z.string() })])
export type ChefResponse = z.infer<typeof ChefResponseSchema>
