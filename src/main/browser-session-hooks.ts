import type { ProjectsState } from '../shared/projects.js'
import { setTabLastUrl } from './projects-state.js'

export interface RememberUrlDeps {
  /** about:blank、錯誤頁一類的網址不算「上次看的頁面」(每對話瀏覽器規格 §4.6)。 */
  shouldRemember(url: string): boolean
  update(fn: (state: ProjectsState) => ProjectsState): void
}

/**
 * 每對話瀏覽器規格 §4.6:導航完成才記,所以錯誤頁與 about:blank 不會蓋掉上次的頁面。
 * `browserSessions` 的 `onNavigated` 直接用這個。
 */
export function createRememberUrl(deps: RememberUrlDeps): (conversationId: string, url: string) => void {
  return (conversationId, url) => {
    if (!deps.shouldRemember(url)) return
    deps.update((state) => setTabLastUrl(state, conversationId, url))
  }
}
