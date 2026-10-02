import { SkillsRequestSchema, type SkillsResponse } from '../../shared/skills.js'
import type { SharedSkillsService } from './service.js'

export function createSkillsHandler(service: Pick<SharedSkillsService, 'handle'>, allowed: (sender: unknown) => boolean) {
  return async (event: { sender: unknown }, raw: unknown): Promise<SkillsResponse> => {
    if (!allowed(event.sender)) return { kind: 'error', message: '不接受此來源的 Skills 請求' }
    const parsed = SkillsRequestSchema.safeParse(raw)
    if (!parsed.success) return { kind: 'error', message: 'Skills 請求格式不正確' }
    return service.handle(parsed.data)
  }
}
