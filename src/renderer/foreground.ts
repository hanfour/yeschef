import type { ProjectView } from '../shared/projects.js'

/**
 * 一個專案的前景對話:`lastFocusedAt` 最大的 conversation 分頁。主行程用同一條規則
 * 決定哪個 core 是前景(projects-state.ts 的 `activeConversationId`),兩邊算出來要一樣。
 */
export function foregroundConversationId(project: ProjectView | undefined): string | null {
  if (project === undefined) return null
  const tabs = project.tabs.filter((t) => t.contentType === 'conversation')
  const best = tabs.reduce<typeof tabs[number] | undefined>(
    (acc, t) => (acc === undefined || t.lastFocusedAt > acc.lastFocusedAt ? t : acc),
    undefined
  )
  return best?.id ?? null
}
