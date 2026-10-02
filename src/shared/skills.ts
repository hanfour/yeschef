import { z } from 'zod'

export const SkillName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const SkillSourceSchema = z.object({ url: z.string(), ref: z.string(), path: z.string() })
export const InstalledSkillSchema = z.object({
  id: z.string().uuid(), name: SkillName, description: z.string(), source: SkillSourceSchema,
  commit: z.string().regex(/^[a-f0-9]{40,64}$/), enabled: z.boolean(), installedAt: z.string(),
})
export const SkillsStateSchema = z.object({ revision: z.string().uuid().nullable(), skills: z.array(InstalledSkillSchema) })
export const SkillCandidateSchema = z.object({ path: z.string(), name: SkillName, description: z.string(), markdown: z.string() })
export const SkillInspectionSchema = z.object({
  id: z.string().uuid(), url: z.string(), ref: z.string(), commit: z.string(),
  candidates: z.array(SkillCandidateSchema), warnings: z.array(z.string()),
})
export const SkillsRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('inspect'), url: z.string().min(1).max(1000) }),
  z.object({ action: z.literal('install'), inspectionId: z.string().uuid(), paths: z.array(z.string().max(500)).min(1).max(100) }),
  z.object({ action: z.literal('enable'), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({ action: z.literal('remove'), id: z.string().uuid() }),
])
export const SkillsResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: SkillsStateSchema }),
  z.object({ kind: z.literal('inspection'), inspection: SkillInspectionSchema }),
  z.object({ kind: z.literal('error'), message: z.string() }),
])
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>
export type SkillsState = z.infer<typeof SkillsStateSchema>
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>
export type SkillInspection = z.infer<typeof SkillInspectionSchema>
export type SkillsRequest = z.infer<typeof SkillsRequestSchema>
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>
export const SKILLS_CHANNEL = 'skills:manage'
