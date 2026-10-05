// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ProjectBar } from '../src/renderer/components/ProjectBar.js'
import { EMPTY_PROJECTS, fakeProjects, ONE_PROJECT, projectView } from './helpers/fake-yeschef.js'
import type { ProjectsView } from '../src/shared/projects.js'
import { BrowserSessionsContext } from '../src/renderer/browser-context.js'

afterEach(cleanup)

const TWO: ProjectsView = {
  activeId: 'a',
  projects: [projectView('a', { name: 'mirage' }), projectView('b', { name: 'yeschef' })],
}

describe('ProjectBar', () => {
  it('專案底下有對話的瀏覽器正在被操作時,專案格顯示記號', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: true }]}>
        <ProjectBar projects={fakeProjects(TWO).projects} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.getAllByRole('img', { name: '瀏覽器操作中' })).toHaveLength(1)
  })

  it('只有閒置的瀏覽器時,專案格不顯示記號', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: false }]}>
        <ProjectBar projects={fakeProjects(TWO).projects} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.queryByRole('img', { name: '瀏覽器操作中' })).toBeNull()
  })

  it('每個專案一格,active 的 aria-selected 為 true,點別格呼叫 activate', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[0]?.className).toContain('on')
    fireEvent.click(screen.getByRole('tab', { name: /yeschef/ }))
    expect(calls).toEqual(['activate:b'])
  })

  it('pendingApproval 顯示待批准記號;不可用的專案顯示 ! 並帶 unavailable class', () => {
    const view: ProjectsView = {
      activeId: 'a',
      projects: [
        projectView('a', { name: 'mirage', pendingApproval: true }),
        projectView('b', { name: 'gone', available: false }),
      ],
    }
    const { projects } = fakeProjects(view)
    render(<ProjectBar projects={projects} />)
    expect(screen.getAllByTitle('有待批准的請求')).toHaveLength(1)
    expect(screen.getAllByTitle('資料夾不存在')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /gone/ }).className).toContain('unavailable')
    expect(screen.getByRole('tab', { name: /mirage/ }).className).not.toContain('unavailable')
  })

  it('移除鈕呼叫 remove,而且不會順便 activate 那一格', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    fireEvent.click(screen.getByRole('button', { name: '移除專案 yeschef' }))
    expect(calls).toEqual(['remove:b'])
  })

  it('+ 呼叫 add', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    fireEvent.click(screen.getByRole('button', { name: '加入專案' }))
    expect(calls).toEqual(['add'])
  })

  it('error 以 role=alert 顯示在專案列下方;沒有 error 就沒有那個元素', () => {
    const withError = fakeProjects(TWO, { error: '這個資料夾不能當專案' }).projects
    const { rerender } = render(<ProjectBar projects={withError} />)
    expect(screen.getByRole('alert').textContent).toBe('這個資料夾不能當專案')
    rerender(<ProjectBar projects={fakeProjects(TWO).projects} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('沒有專案時只剩加入鈕', () => {
    const { projects } = fakeProjects(EMPTY_PROJECTS)
    render(<ProjectBar projects={projects} />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '加入專案' })).toBeTruthy()
  })
})

it('在跑記號只畫在 busy 的項目，且在待批准前並存', () => {
  const busy = projectView('a', { busyTabIds: ['a-conv'], pendingTabIds: ['a-conv'], pendingApproval: true })
  const { container, rerender } = render(<ProjectBar projects={fakeProjects({ activeId: 'a', projects: [busy] }).projects} />)
  const mark = screen.getByRole('img', { name: '執行中' })
  expect(mark.textContent).toBe('◐')
  expect(mark.title).toBe('執行中')
  expect(mark.className).toBe('project-busy')
  expect(mark.nextElementSibling?.className).toBe('project-pending')
  rerender(<ProjectBar projects={fakeProjects({ activeId: 'a', projects: [projectView('a')] }).projects} />)
  expect(container.querySelector('.project-busy')).toBeNull()
})

it('受管服務執行中時顯示專案狀態點', () => {
  const { projects } = fakeProjects(ONE_PROJECT)
  render(<ProjectBar projects={projects} projectRunStatuses={{ 'p-1': {
    projectId: 'p-1', state: 'running', restarted: false, port: 5173,
  } }} />)
  expect(screen.getByRole('img', { name: '專案服務執行中' }).className).toContain('running')
})
