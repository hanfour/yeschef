import { z } from 'zod'
export const PERMISSIONS_CHANNEL = 'permissions:manage'
export const FilePolicySchema = z.object({
  projectId: z.string().min(1).max(200),
  mode: z.enum(['manual', 'rules', 'review']),
  read: z.boolean(), write: z.boolean(),
  excluded: z.array(z.string().min(1).max(500)).max(50),
  purpose: z.string().max(4000),
}).strict()
export type FilePolicy = z.infer<typeof FilePolicySchema>
export const PermissionStateSchema = z.object({ revision: z.number().int().nonnegative(), paused: z.boolean(), policies: z.array(FilePolicySchema) })
export type PermissionState = z.infer<typeof PermissionStateSchema>
export const AuditSchema = z.object({ id: z.string(), at: z.string(), projectId: z.string(), conversationId: z.string(), tool: z.string(), decision: z.enum(['allow', 'deny', 'manual']), source: z.enum(['rule', 'review', 'user', 'system']), reason: z.string(), revision: z.number(), requestHash: z.string(), summary: z.string().max(200).optional() })
export type PermissionAudit = z.infer<typeof AuditSchema>
export const PermissionsRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('save'), revision: z.number().int(), policy: FilePolicySchema }).strict(),
  z.object({ action: z.literal('pause'), revision: z.number().int(), paused: z.boolean() }).strict(),
  z.object({ action: z.literal('export'), projectId: z.string().min(1).max(200) }).strict(),
])
export const PermissionsResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: PermissionStateSchema, audit: z.array(AuditSchema), error: z.string().optional() }),
  z.object({ kind: z.literal('exported'), path: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])
export type PermissionsRequest = z.infer<typeof PermissionsRequestSchema>
export type PermissionsResponse = z.infer<typeof PermissionsResponseSchema>
export const emptyPolicy = (projectId: string): FilePolicy => ({ projectId, mode: 'manual', read: false, write: false, excluded: ['.git', '.env'], purpose: '' })
