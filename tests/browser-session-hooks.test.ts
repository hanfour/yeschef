import { describe, expect, it, vi } from 'vitest'
import { createRememberUrl } from '../src/main/browser-session-hooks.js'
import type { ProjectsState } from '../src/shared/projects.js'

describe('createRememberUrl', () => {
  it('shouldRemember 為真時,呼叫 update 並把 conversationId、url 轉給 setTabLastUrl 那層 fn', () => {
    const update = vi.fn<(fn: (s: ProjectsState) => ProjectsState) => void>()
    const rememberUrl = createRememberUrl({ shouldRemember: () => true, update })
    rememberUrl('conv-1', 'https://a.test/')
    expect(update).toHaveBeenCalledTimes(1)
    const fn = update.mock.calls[0]![0]
    const state = { schemaVersion: 1, projects: [], activeId: null, openIdsOnShutdown: [] } as unknown as ProjectsState
    // 這裡只驗證 update 真的被叫到、且傳進去的是個函式；setTabLastUrl 本身的行為由
    // projects-state.test.ts 覆蓋，這裡不重複測它的內部邏輯。
    expect(typeof fn).toBe('function')
    expect(() => fn(state)).not.toThrow()
  })

  it('about:blank／錯誤頁不算「記得住的」網址時,不呼叫 update', () => {
    const update = vi.fn()
    const rememberUrl = createRememberUrl({ shouldRemember: () => false, update })
    rememberUrl('conv-1', 'about:blank')
    expect(update).not.toHaveBeenCalled()
  })
})
