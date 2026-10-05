import { z } from 'zod'

export const PROJECT_RUN_CHANNEL = 'projectRun:manage'

export const ProjectRunCandidateSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable(),
  source: z.string().min(1),
  watchEnabled: z.boolean().optional(),
}).strict()
export type ProjectRunCandidate = z.infer<typeof ProjectRunCandidateSchema>

export const ProjectRunConfigSchema = z.object({
  version: z.literal(1),
  command: z.string().trim().min(1).max(4000),
  cwd: z.string().min(1).max(1000).refine(path => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(path) && !path.split(/[\\/]/).includes('..')),
  port: z.number().int().min(1).max(65535),
  url: z.string().min(1).max(2000).refine(value => {
    try {
      const url = new URL(value.replaceAll('{port}', '3000'))
      return ['http:', 'https:'].includes(url.protocol)
    } catch {
      return false
    }
  }),
  readyPath: z.string().startsWith('/').max(1000),
  env: z.record(z.string(), z.string().max(4000)).refine(value =>
    Object.keys(value).every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))),
  portStrategy: z.enum(['fixed', 'placeholder']),
  watch: z.object({
    enabled: z.boolean(),
    include: z.array(z.string().min(1).max(500)).max(100),
    exclude: z.array(z.string().min(1).max(500)).max(100),
  }).strict(),
  openInBrowser: z.boolean(),
}).strict().refine(config => config.portStrategy !== 'placeholder'
  || config.command.includes('{port}') || Object.values(config.env).some(value => value.includes('{port}')))
export type ProjectRunConfig = z.infer<typeof ProjectRunConfigSchema>

export const ProjectRunStatusSchema = z.object({
  projectId: z.string().min(1),
  state: z.enum(['stopped', 'starting', 'running', 'restarting', 'failed']),
  pid: z.number().int().positive().optional(),
  pgid: z.number().int().positive().optional(),
  processName: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  restarted: z.boolean(),
  conflict: z.object({ pid: z.number().int().positive(), processName: z.string(), projectName: z.string().optional() }).strict().optional(),
  error: z.string().optional(),
  lastExit: z.object({ at: z.number().int().nonnegative(), code: z.number().int().nullable(), signal: z.string().nullable() }).strict().optional(),
}).strict()
export type ProjectRunStatus = z.infer<typeof ProjectRunStatusSchema>

export const ProjectRunUpdateSchema = z.object({
  projectId: z.string().min(1),
  snapshot: ProjectRunStatusSchema,
  logs: z.array(z.string()).max(2000),
}).strict()
export type ProjectRunUpdate = z.infer<typeof ProjectRunUpdateSchema>

export const ProjectRunRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('save'), projectId: z.string().min(1), config: ProjectRunConfigSchema }).strict(),
  z.object({ action: z.literal('start'), projectId: z.string().min(1), useFreePort: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('stop'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('restart'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('open'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('refresh'), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('openLog'), projectId: z.string().min(1) }).strict(),
])
export type ProjectRunRequest = z.infer<typeof ProjectRunRequestSchema>

export const ProjectRunResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('state'),
    config: ProjectRunConfigSchema.optional(),
    candidates: z.array(ProjectRunCandidateSchema),
    snapshot: ProjectRunStatusSchema,
    logs: z.array(z.string()).max(2000),
    logPath: z.string(),
  }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])
export type ProjectRunResponse = z.infer<typeof ProjectRunResponseSchema>

export function parseProjectRunRequest(raw: unknown): ProjectRunRequest | null {
  const parsed = ProjectRunRequestSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseProjectRunUpdate(raw: unknown): ProjectRunUpdate | null {
  const parsed = ProjectRunUpdateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
