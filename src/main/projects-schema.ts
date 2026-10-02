/**
 * 狀態檔的執行期形狀驗證(規格 §4.1,版本 2)。zod 只在 main 使用(與 view-tools/server.ts 同樣的用法)。
 * renderer 不 import 這個檔案。版本 1 先經 projects-migrate.ts 轉換再進這裡。
 */
import { z } from 'zod'
import { PROJECTS_SCHEMA_VERSION, providerSchema, type ProjectsState } from '../shared/projects.js'

const switchTargetSchema = z.object({
  provider: providerSchema,
  requestedModel: z.string().nullable(),
})

const switchModeSchema = z.enum(['handoff', 'failure-recovery'])

const switchPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('preparing'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema, startedAt: z.number() }),
  z.object({
    kind: z.literal('spawning'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema,
    handoffVersion: z.number(), recoveryRequired: z.boolean(),
  }),
  z.object({
    kind: z.literal('receiving'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema,
    newLinkId: z.string(), newSessionId: z.string(),
  }),
])

const sessionLinkSchema = z.object({
  cost: z.object({ usd: z.number().optional(), turns: z.number().optional(), tokens: z.number().optional() }).optional(),
  linkId: z.string().min(1),
  provider: providerSchema,
  sessionId: z.string().min(1),
  transcriptPath: z.string().nullable(),
  parentLinkId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  endReason: z.enum(['handoff', 'failure-recovery', 'user']).nullable(),
  models: z.array(z.string()),
})

const threadSchema = z.object({
  id: z.string().min(1),
  sessions: z.array(sessionLinkSchema),
  handoffVersion: z.number().int().nonnegative(),
  switchPhase: switchPhaseSchema,
  createdAt: z.number(),
})

const tabSchema = z.object({
  id: z.string().min(1),
  contentType: z.enum(['conversation', 'terminal', 'group']),
  label: z.string(),
  customLabel: z.string().nullable(),
  command: z.string().optional(),
  worktreePath: z.string().optional(),
  chefTaskId: z.string().optional(),
  sortOrder: z.number(),
  lastFocusedAt: z.number(),
  threadId: z.string().optional(),
  provider: providerSchema.optional(),
  lastUrl: z.string().nullable().optional(),
})

const projectSchema = z
  .object({
    isGitRepo: z.boolean().optional(),
    id: z.string().min(1),
    rootPath: z.string().min(1),
    name: z.string(),
    addedAt: z.number(),
    lastOpenedAt: z.number(),
    tabs: z.array(tabSchema),
    lastUrl: z.string().nullable(),
    threads: z.array(threadSchema),
  })
  // D2 規格 §3:每個專案至少一個對話分頁。
  .refine((p) => p.tabs.some((t) => t.contentType === 'conversation'), {
    message: '每個專案至少要有一個對話分頁',
  })

const stateSchema = z.object({
  schemaVersion: z.literal(PROJECTS_SCHEMA_VERSION),
  projects: z.array(projectSchema),
  activeId: z.string().nullable(),
  openIdsOnShutdown: z.array(z.string()),
})

export function parseProjectsState(raw: unknown): ProjectsState | null {
  const result = stateSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** 只讀版本欄位,讓 store 分辨「版本不認得」與「內容損毀」。 */
export function readSchemaVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = (raw as Record<string, unknown>)['schemaVersion']
  return typeof v === 'number' ? v : undefined
}
