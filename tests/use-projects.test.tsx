// @vitest-environment jsdom
import type { Provider } from '../src/shared/projects.js'
import { describe, it, expect, afterEach } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { ProjectBar } from '../src/renderer/components/ProjectBar.js'
import { EMPTY_VIEW, useProjects } from '../src/renderer/hooks/useProjects.js'
import type { YesChefApi } from '../src/shared/ipc.js'
import type { AddProjectResult, ProjectsView, ProjectView } from '../src/shared/projects.js'

afterEach(cleanup)

function project(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name: id,
    rootPath: `/p/${id}`,
    available: true,
    pendingApproval: false,
    pendingTabIds: [],
    busyTabIds: [],
    busySince: {},
    producingTabIds: [],
    activeTabId: `${id}-conv`,
    tabs: [
      { id: `${id}-conv`, contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: `${id}-th` },
    ],
    threads: [{ id: `${id}-th`, sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    ...over,
  }
}

const TWO: ProjectsView = { activeId: 'a', projects: [project('a'), project('b')] }

interface Harness {
  readonly api: YesChefApi
  readonly calls: string[]
  push(view: ProjectsView): void
  unsubscribed(): number
}

function harness(opts: {
  readonly initial?: ProjectsView | Error
  readonly add?: AddProjectResult | Error
  readonly relocate?: AddProjectResult | Error
} = {}): Harness {
  const calls: string[] = []
  const listeners = new Set<(view: ProjectsView) => void>()
  let unsubscribed = 0
  const settle = <T,>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback)
  const api = {
    onProjects: (cb: (view: ProjectsView) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
        unsubscribed += 1
      }
    },
    openConversation: (projectId: string, provider: Provider, worktreeName?: string) => { calls.push(`openConversation:${projectId}:${provider}${worktreeName === undefined ? '' : `:${worktreeName}`}`) },
    openGroup: (projectId: string) => { calls.push(`openGroup:${projectId}`) },
    getProjects: () => {
      calls.push('getProjects')
      return settle(opts.initial, TWO)
    },
    addProject: () => {
      calls.push('addProject')
      return settle(opts.add, { kind: 'cancelled' } as AddProjectResult)
    },
    relocateProject: (id: string) => {
      calls.push(`relocateProject:${id}`)
      return settle(opts.relocate, { kind: 'cancelled' } as AddProjectResult)
    },
    removeProject: (id: string) => { calls.push(`removeProject:${id}`) },
    activateProject: (id: string) => { calls.push(`activateProject:${id}`) },
    openTab: (p: { projectId: string; label: string; command?: string }) => {
      calls.push(`openTab:${p.projectId}:${p.label}:${p.command ?? '-'}`)
    },
    closeTab: (p: { projectId: string; tabId: string }) => { calls.push(`closeTab:${p.projectId}:${p.tabId}`) },
    activateTab: (p: { projectId: string; tabId: string }) => { calls.push(`activateTab:${p.projectId}:${p.tabId}`) },
  } as unknown as YesChefApi
  return {
    api,
    calls,
    push: (view) => {
      act(() => {
        for (const l of listeners) l(view)
      })
    },
    unsubscribed: () => unsubscribed,
  }
}

describe('useProjects 的載入', () => {
  it('掛載時先訂閱再 getProjects;回來之前 loaded 為 false、view 為空', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    expect(result.current.loaded).toBe(false)
    expect(result.current.view).toEqual(EMPTY_VIEW)
    expect(result.current.active).toBeUndefined()
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    expect(result.current.view).toEqual(TWO)
    expect(result.current.active?.id).toBe('a')
    expect(h.calls).toEqual(['getProjects'])
  })

  it('主行程推來的 view 直接取代;activeId 為 null 時 active 是 undefined', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    h.push({ activeId: 'b', projects: TWO.projects })
    expect(result.current.active?.id).toBe('b')
    h.push({ activeId: null, projects: [] })
    expect(result.current.active).toBeUndefined()
    expect(result.current.loaded).toBe(true)
  })

  it('getProjects 失敗:error 有訊息,loaded 也變 true(讓使用者看得到錯誤而不是永遠空白)', async () => {
    const h = harness({ initial: new Error('projects:get 回傳的形狀不符，無法顯示專案清單') })
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('projects:get 回傳的形狀不符，無法顯示專案清單')
    })
    expect(result.current.loaded).toBe(true)
  })

  it('卸載時取消訂閱', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useProjects(h.api))
    unmount()
    expect(h.unsubscribed()).toBe(1)
  })

  it('推送先到時,晚到的初始 getProjects 不覆蓋較新狀態', async () => {
    const listeners = new Set<(view: ProjectsView) => void>()
    let resolveInitial: (view: ProjectsView) => void = () => undefined
    // 保留同一個 promise 實例:hook 的 `.then()` 在掛載時就掛上去了,
    // 測試在這裡 `await` 同一個 promise 才能保證它的 reaction 先跑完,
    // 不然 `loaded` 早被推播設成 true,`waitFor` 會在 getProjects 的
    // then 執行之前就通過,測不出這條回歸。
    const initial = new Promise<ProjectsView>((resolve) => {
      resolveInitial = resolve
    })
    const api = {
      onProjects: (cb: (view: ProjectsView) => void) => {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
      getProjects: () => initial,
    } as unknown as YesChefApi

    const { result } = renderHook(() => useProjects(api))
    const NEWER: ProjectsView = { activeId: 'b', projects: TWO.projects }
    act(() => {
      for (const l of listeners) l(NEWER)
    })
    expect(result.current.view).toEqual(NEWER)

    await act(async () => {
      resolveInitial(TWO)
      await initial
    })

    expect(result.current.view).toEqual(NEWER)
    expect(result.current.loaded).toBe(true)
  })
})

describe('useProjects 的動作', () => {
  it('activate / remove 直接轉給 api', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    result.current.activate('b')
    result.current.remove('a')
    expect(h.calls.slice(1)).toEqual(['activateProject:b', 'removeProject:a'])
  })

  it('分頁動作帶 active 專案的 id;沒有 active 專案時不送', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    act(() => {
      result.current.openTab('codex', 'codex')
      result.current.openTab('zsh')
      result.current.closeTab('a-t1')
      result.current.activateTab('a-conv')
    })
    expect(h.calls.slice(1)).toEqual([
      'openTab:a:codex:codex',
      'openTab:a:zsh:-',
      'closeTab:a:a-t1',
      'activateTab:a:a-conv',
    ])

    h.push({ activeId: null, projects: [] })
    h.calls.length = 0
    act(() => {
      result.current.openTab('zsh')
      result.current.closeTab('x')
      result.current.activateTab('x')
    })
    expect(h.calls).toEqual([])
  })

  it('activateTab 指定 projectId 時優先使用目標專案,省略時仍用 activeId', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => {
      result.current.activate('b')
      result.current.activateTab('b-conv', 'b')
      result.current.activateTab('a-conv')
    })
    expect(h.calls.slice(1)).toEqual([
      'activateProject:b',
      'activateTab:b:b-conv',
      'activateTab:a:a-conv',
    ])
    h.push({ activeId: null, projects: TWO.projects })
    h.calls.length = 0
    result.current.activateTab('b-conv', 'b')
    expect(h.calls).toEqual(['activateTab:b:b-conv'])
  })

  it('add 被拒時 error 是主行程給的原因;下一次成功就清掉', async () => {
    const h = harness({ add: { kind: 'rejected', message: '這個資料夾不能當專案' } })
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    await act(() => result.current.add())
    expect(result.current.error).toBe('這個資料夾不能當專案')

    const ok = harness({ add: { kind: 'added', id: 'c' } })
    const second = renderHook(() => useProjects(ok.api))
    await waitFor(() => {
      expect(second.result.current.loaded).toBe(true)
    })
    await act(() => second.result.current.add())
    expect(second.result.current.error).toBeUndefined()
  })

  it('add 取消不算錯誤', async () => {
    const h = harness({ add: { kind: 'cancelled' } })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.add())
    expect(result.current.error).toBeUndefined()
  })

  it('add 的 IPC 拋錯時 error 是那個訊息', async () => {
    const h = harness({ add: new Error('projects:add 回傳的形狀不符') })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.add())
    expect(result.current.error).toBe('projects:add 回傳的形狀不符')
  })

  it('relocate 帶 id,結果處理與 add 相同', async () => {
    const h = harness({ relocate: { kind: 'rejected', message: '資料夾不存在' } })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.relocate('b'))
    expect(h.calls).toContain('relocateProject:b')
    expect(result.current.error).toBe('資料夾不存在')
  })
})

it('openConversation 對 active 專案送 conversations:open;沒有 active 專案不送', async () => {
  const { api, calls, push } = harness({ initial: { activeId: 'a', projects: [project('a')] } })
  const { result } = renderHook(() => useProjects(api))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  act(() => { result.current.openConversation() })
  expect(calls).toContain('openConversation:a:claude')
  act(() => { result.current.openConversation('codex') })
  expect(calls).toContain('openConversation:a:codex')
  push({ activeId: null, projects: [] })
  calls.length = 0
  act(() => { result.current.openConversation() })
  expect(calls).toEqual([])
})

it('openGroup 對 active 專案送 group:open;沒有 active 專案不送', async () => {
  const { api, calls, push } = harness({ initial: { activeId: 'a', projects: [project('a')] } })
  const { result } = renderHook(() => useProjects(api))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  act(() => { result.current.openGroup() })
  expect(calls).toContain('openGroup:a')
  push({ activeId: null, projects: [] })
  calls.length = 0
  act(() => { result.current.openGroup() })
  expect(calls).toEqual([])
})


it('worktreeName 從 hook 送到 preload API', async () => {
  const rig = harness()
  const { result } = renderHook(() => useProjects(rig.api))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  act(() => result.current.openConversation('codex', '測試一'))
  expect(rig.calls).toContain('openConversation:a:codex:測試一')
})

it.each([true, false])('dirty 訊息透過既有 ProjectBar 顯示（初始查詢：%s）', async (initial) => {
  const message = 'worktree 還有未提交的改動,留在 /repo/.worktrees/測試一,請自己處理'
  const rig = harness({ initial: initial ? { ...TWO, error: message } : TWO })
  function Display(): React.ReactElement {
    return <ProjectBar projects={useProjects(rig.api)} />
  }
  render(<Display />)
  if (!initial) rig.push({ ...TWO, error: message })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
})

it('收到沒有 error 的 view 時 ProjectBar 移除錯誤訊息', async () => {
  const rig = harness({ initial: { ...TWO, error: '舊錯誤' } })
  function Display(): React.ReactElement {
    return <ProjectBar projects={useProjects(rig.api)} />
  }
  render(<Display />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('舊錯誤'))
  rig.push(TWO)
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
