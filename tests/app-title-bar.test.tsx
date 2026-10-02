// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import { NO_PROJECT_TITLE } from '../src/renderer/title.js'
import { createFakeYesChef, EMPTY_PROJECTS, ONE_PROJECT } from './helpers/fake-yeschef.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function titleBarText(container: HTMLElement) {
  return container.querySelector('.title-text')?.textContent
}

describe('App 標題列', () => {
  it('沒有專案時顯示提示', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(EMPTY_PROJECTS)
    expect(titleBarText(container)).toBe(NO_PROJECT_TITLE)
  })

  it('顯示 active 專案的名稱', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    expect(titleBarText(container)).toBe('demo')
  })

  it('主行程推新的清單時標題跟著換', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const renamed = { ...ONE_PROJECT, projects: ONE_PROJECT.projects.map((p) => ({ ...p, name: 'demo-2' })) }
    fake.emitProjects(renamed)
    expect(titleBarText(container)).toBe('demo-2')
  })
})
