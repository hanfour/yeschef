import type { ExternalWrite } from './external-codex-activity.js'
import { isAbsolute, resolve } from 'node:path'
import { normalizeHistory, type Event } from '../shared/events.js'
export interface ConversationActivity { groups: readonly (readonly Event[])[]; warnings: string[]; externalWrites?: ExternalWrite[] }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** Only matched successful write results count; prose, reads, intent and dirty state are not evidence. */
export function writtenPaths(activity: ConversationActivity, defaultCwd: string): string[] {
  const paths = new Set<string>()
  for (const events of activity.groups) {
    const groupPaths = new Set<string>()
    let cwd = defaultCwd
    const tools = new Map<string, { name: string; input: unknown; cwd: string }>()
    const completed = new Set<string>()
    for (const event of events) {
      if (event.kind === 'session-start' && event.cwd && isAbsolute(event.cwd)) cwd = event.cwd
      if (event.kind === 'reset') { tools.clear(); completed.clear(); groupPaths.clear() }
      if (event.kind === 'permission-denied') { tools.delete(event.toolUseId); completed.add(event.toolUseId) }
      if (event.kind === 'tool-use') tools.set(event.id, { name: event.name, input: event.input, cwd })
      if (event.kind !== 'tool-result' || event.isError || completed.has(event.id)) continue
      const tool = tools.get(event.id)
      if (!tool) continue
      completed.add(event.id)
      const input = record(tool.input)
      if (!input) continue
      const add = (value: unknown) => { if (typeof value === 'string' && value.length > 0 && value.length < 32768 && !value.includes('\0')) groupPaths.add(resolve(tool.cwd, value)) }
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
        if (Array.isArray(input.changes)) {
          const result = record(event.content)
          if (result?.status !== 'completed') continue
          for (const raw of input.changes) {
            const change = record(raw), kind = record(change?.kind)
            if (!change || !kind || !['add', 'update', 'delete'].includes(String(kind.type))) continue
            add(change.path); add(kind.move_path); add(kind.movePath)
          }
        } else {
          if (tool.name === 'Edit' && typeof input.old_string === 'string' && input.old_string === input.new_string) continue
          add(tool.name === 'NotebookEdit' ? input.notebook_path : input.file_path)
        }
      } else if (tool.name === 'apply_patch') {
        const patch = input.patch ?? input.input
        if (typeof patch !== 'string') continue
        for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) add(match[1])
      }
    }
    for (const path of groupPaths) paths.add(path)
  }
  return [...paths]
}
export function createClaudeActivityReader(deps: {
  getSessionMessages(sessionId: string, options?: { limit: number }): Promise<readonly unknown[]>
  listSubagents(sessionId: string): Promise<string[]>
  getSubagentMessages(sessionId: string, agentId: string, options?: { limit: number }): Promise<readonly unknown[]>
}) {
  return async (sessionId: string): Promise<ConversationActivity> => {
    const groups: Event[][] = [], warnings: string[] = []
    const main = await deps.getSessionMessages(sessionId, { limit: 10000 })
    if (main.length >= 10000) warnings.push('歷史訊息達讀取上限，清單僅包含可驗證紀錄。')
    groups.push(main.flatMap(message => [...normalizeHistory(message)]))
    let agents: string[] = []
    try { agents = await deps.listSubagents(sessionId) } catch { warnings.push('部分子 agent 紀錄無法讀取，清單可能不完整。') }
    if (agents.length > 32) warnings.push('子 agent 超過 32 個，僅檢查前 32 個紀錄。')
    for (const id of agents.slice(0, 32)) {
      try { groups.push((await deps.getSubagentMessages(sessionId, id, { limit: 10000 })).flatMap(message => [...normalizeHistory(message)])) }
      catch { warnings.push('部分子 agent 紀錄無法讀取，清單可能不完整。') }
    }
    if (groups.some(events => events.some(e => e.kind === 'compact-summary'))) warnings.push('歷史曾經壓縮，較早的修改以已保存的歸屬紀錄為準；未能驗證的項目不推測。')
    return { groups, warnings: [...new Set(warnings)] }
  }
}
