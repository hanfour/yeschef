// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceHistory } from '../src/renderer/components/WorkspaceHistory.js'
import { createFakeYesChef, fakeProjects, projectView } from './helpers/fake-yeschef.js'
import type { ProjectsView } from '../src/shared/projects.js'
afterEach(cleanup)
const tabs = [
  { id: 'claude', contentType: 'conversation' as const, provider: 'claude' as const, label: 'Claude', customLabel: null, sortOrder: 0, lastFocusedAt: 1 },
  { id: 'codex', contentType: 'conversation' as const, provider: 'codex' as const, label: 'Codex', customLabel: null, sortOrder: 1, lastFocusedAt: 2 },
  { id: 'term', contentType: 'terminal' as const, label: 'zsh', customLabel: null, sortOrder: 2, lastFocusedAt: 3 },
]
const view = (activeTabId: string): ProjectsView => ({ activeId: 'p', projects: [projectView('p', { tabs, activeTabId })] })
it('keeps the same sidebar and search when switching Claude, Codex and terminal; history opens in the correct conversation', async () => {
  const fake = createFakeYesChef()
  const activateTab = vi.fn(), openHistory = vi.fn()
  const api = { ...fake.api, activateTab, openHistory, listSessions: vi.fn(async () => [{ sessionId: 's', summary: 'matching session', lastModified: Date.now() }]) }
  const props = (id: string) => ({ api, projects: fakeProjects(view(id)).projects })
  const { rerender, container } = render(<WorkspaceHistory {...props('claude')} />)
  const sidebar = container.querySelector('.sidebar')
  await screen.findByText('matching session')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'matching' } })
  rerender(<WorkspaceHistory {...props('codex')} />)
  await waitFor(() => expect(api.listSessions).toHaveBeenLastCalledWith({ projectId: 'p', provider: 'codex' }))
  rerender(<WorkspaceHistory {...props('term')} />)
  expect(container.querySelector('.sidebar')).toBe(sidebar)
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('matching')
  fireEvent.click(await screen.findByText('matching session'))
  expect(activateTab).toHaveBeenCalledWith({ projectId: 'p', tabId: 'codex' })
  expect(openHistory).toHaveBeenCalledWith('s')
  expect(activateTab.mock.invocationCallOrder[0]).toBeLessThan(openHistory.mock.invocationCallOrder[0]!)
})
it('does not display stale Claude entries while Codex history is loading', async () => {
  const fake = createFakeYesChef()
  const api = { ...fake.api, listSessions: vi.fn(async ({ provider }: { provider?: string }) => provider === 'codex' ? new Promise<never>(() => {}) : [{ sessionId: 'c', summary: 'Claude-only', lastModified: Date.now() }]) }
  const { rerender } = render(<WorkspaceHistory api={api} projects={fakeProjects(view('claude')).projects} />)
  await screen.findByText('Claude-only')
  rerender(<WorkspaceHistory api={api} projects={fakeProjects(view('codex')).projects} />)
  expect(screen.queryByText('Claude-only')).toBeNull()
  expect(screen.getByRole('navigation', { name: '歷史對話' })).not.toBeNull()
})
