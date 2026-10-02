import { z } from 'zod'

export const ERROR_INTAKE_CHANNEL = 'errorIntake:manage'
export const ERROR_INTAKE_PACKAGE_SOURCE = '@yeschef/error-intake'
export const ERROR_INTAKE_SETUP_TOOL_NAMES = ['configure_error_intake_env', 'check_error_intake'] as const
export type ErrorIntakeSetupToolName = (typeof ERROR_INTAKE_SETUP_TOOL_NAMES)[number]

const hostSchema = z.string().trim().min(1).max(255).refine(isHostname, '主機格式不正確')

const settingsInputSchema = z.object({
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(64),
  tls: z.boolean(),
  adminUsername: z.string().trim().min(1).max(32),
  adminPassword: z.string().min(1).max(1024).optional(),
  packageSource: z.string().trim().min(1).max(1024).optional(),
}).strict()

export const ErrorIntakeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('save'), settings: settingsInputSchema }).strict(),
  z.object({ action: z.literal('initialize'), recovery: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('project'), projectId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('enable'), projectId: z.string().min(1), projectCode: z.string().min(1).max(28),
    acknowledged: z.boolean(), packageSource: z.string().trim().min(1).max(1024),
  }).strict(),
  z.object({ action: z.literal('copy-connection'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('pull-list'), projectId: z.string().min(1), environment: z.enum(['local', 'staging', 'production']).optional() }).strict(),
  z.object({ action: z.literal('set-group-status'), projectId: z.string().min(1), groupId: z.string().min(1).max(26), status: z.enum(['new', 'resolved', 'ignored']) }).strict(),
  z.object({ action: z.literal('start-fix'), projectId: z.string().min(1), groupIds: z.array(z.string().min(1).max(26)).min(1).max(10) }).strict(),
])

export const ErrorIntakeSettingsViewSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  tls: z.boolean(),
  adminUsername: z.string(),
  hasAdminPassword: z.boolean(),
  hasAppPassword: z.boolean(),
  schemaVersion: z.number().int().nullable(),
  packageSource: z.string().default(ERROR_INTAKE_PACKAGE_SOURCE),
}).strict()

export const ErrorIntakeCleanupSchema = z.object({
  ok: z.boolean(),
  deletedEvents: z.number().int().nonnegative(),
  deletedGroups: z.number().int().nonnegative(),
  message: z.string(),
}).strict()

export const ErrorIntakeStatusSchema = z.object({
  connected: z.boolean(),
  passwordNeedsReentry: z.boolean(),
  schemaVersion: z.number().int().nullable(),
  lastCleanupAt: z.string().nullable(),
  lastCleanup: ErrorIntakeCleanupSchema.nullable(),
}).strict()

export const ErrorIntakeEnvironmentSchema = z.enum(['local', 'staging', 'production'])
export const ErrorIntakeGroupStatusSchema = z.enum(['new', 'in_progress', 'resolved', 'ignored'])
export const ErrorIntakePullGroupSchema = z.object({
  id: z.string(), environment: ErrorIntakeEnvironmentSchema, errorType: z.string(), message: z.string(),
  count: z.number().int().nonnegative(), lastSeenAt: z.string(), route: z.string().nullable(),
  regressedAt: z.string().nullable(), statusNote: z.string().nullable(),
}).strict()

export const ErrorIntakeResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('settings'), settings: ErrorIntakeSettingsViewSchema }).strict(),
  z.object({ kind: z.literal('status'), status: ErrorIntakeStatusSchema }).strict(),
  z.object({ kind: z.literal('initialized'), status: ErrorIntakeStatusSchema }).strict(),
  z.object({
    kind: z.literal('project'), projectId: z.string(), folderName: z.string(), defaultProjectCode: z.string(),
    enabled: z.boolean(), projectCode: z.string().nullable(), projectCodeLocked: z.boolean(), databaseReady: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('enabled'), projectId: z.string(), projectCode: z.string(), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('copied'), projectId: z.string() }).strict(),
  z.object({
    kind: z.literal('pull-list'), environments: z.array(z.enum(['local', 'staging', 'production'])),
    selectedEnvironment: z.enum(['local', 'staging', 'production']),
    newGroups: z.array(ErrorIntakePullGroupSchema), inProgressGroups: z.array(ErrorIntakePullGroupSchema),
  }).strict(),
  z.object({ kind: z.literal('group-status-updated') }).strict(),
  z.object({ kind: z.literal('fix-started'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])

export type ErrorIntakeRequest = z.infer<typeof ErrorIntakeRequestSchema>
export type ErrorIntakeSettingsInput = z.infer<typeof settingsInputSchema>
export type ErrorIntakeSettingsView = z.infer<typeof ErrorIntakeSettingsViewSchema>
export type ErrorIntakeStatus = z.infer<typeof ErrorIntakeStatusSchema>
export type ErrorIntakeCleanup = z.infer<typeof ErrorIntakeCleanupSchema>
export type ErrorIntakeResponse = z.infer<typeof ErrorIntakeResponseSchema>
export type ErrorIntakeProject = Extract<ErrorIntakeResponse, { kind: 'project' }>
export type ErrorIntakeEnvironment = z.infer<typeof ErrorIntakeEnvironmentSchema>
export type ErrorIntakeGroupStatus = z.infer<typeof ErrorIntakeGroupStatusSchema>
export type ErrorIntakePullGroup = z.infer<typeof ErrorIntakePullGroupSchema>
export interface ErrorFixGroup extends ErrorIntakePullGroup {
  readonly fingerprint: string
  readonly stacks: readonly string[]
}

export interface ErrorIntakeGroup {
  readonly source: 'server' | 'browser'
  readonly error_type: string
  readonly route: string | null
  readonly environment: 'local' | 'staging' | 'production'
}

function isHostname(raw: string): boolean {
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  try {
    const parsed = new URL(host.includes(':') ? `http://[${host}]` : `http://${host}`)
    return parsed.hostname !== '' && parsed.username === '' && parsed.password === '' && parsed.port === '' && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
  } catch {
    return false
  }
}
