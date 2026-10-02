// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChefManager } from '../src/renderer/components/ChefManager.js'
import type { ChefRequest, ChefResponse } from '../src/shared/chef.js'
import type { ProjectsView } from '../src/shared/projects.js'
beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(cleanup)
const projects: ProjectsView = { activeId: 'p', projects: [{ id: 'p', name: 'Test', rootPath: '/test', available: true, pendingApproval: false, pendingTabIds: [], busyTabIds: [], producingTabIds: [], busySince: {}, tabs: [], threads: [], activeTabId: '' }] }
const state: ChefResponse = { kind: 'state', state: { tasks: [], notices: [], models: [{ key: 'claude:c', provider: 'claude', model: 'c', label: 'C', description: '', recommended: true }, { key: 'codex:x', provider: 'codex', model: 'x', label: 'X', description: '', recommended: true }] } }
it('does not start on open; submits automatic policy with only the explicitly allowed pool', async () => {
  const manageChef = vi.fn(async (_request: ChefRequest): Promise<ChefResponse> => state)
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} onClose={() => {}} />)
  await screen.findByText('Claude · C')
  expect(screen.getByRole('heading', { name: '自動主廚' })).toBeTruthy()
  expect(screen.getByText('交付目標，讓平台選擇模型、登錄委派並保存交接進度。')).toBeTruthy()
  expect(screen.queryByText('YESCHEF · 任務控制台')).toBeNull()
  expect(manageChef.mock.calls.every(([r]) => r.action === 'get')).toBe(true)
  fireEvent.click(screen.getByText('模型池與執行上限（2 個模型）'))
  fireEvent.click(screen.getByLabelText('Codex · X'))
  fireEvent.click(screen.getByText('重新讀取模型'))
  await waitFor(() => expect((screen.getByLabelText('Codex · X') as HTMLInputElement).disabled).toBe(false))
  expect((screen.getByLabelText('Codex · X') as HTMLInputElement).checked).toBe(false)
  fireEvent.change(screen.getByLabelText('主廚任務目標'), { target: { value: 'Implement feature' } })
  fireEvent.click(screen.getByText('交給主廚'))
  await waitFor(() => expect(manageChef).toHaveBeenCalledWith({ action: 'start', projectId: 'p', goal: 'Implement feature', policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 6, deadlineMinutes: 120 } }))
})
it('retains goal after a failed start and submits pinned model explicitly', async () => {
  const manageChef = vi.fn(async (r: ChefRequest): Promise<ChefResponse> => r.action === 'start' ? { kind: 'error', message: 'Workspace busy' } : state)
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} onClose={() => {}} />)
  await screen.findByText('Claude · C')
  fireEvent.change(screen.getByLabelText('主廚執行方式'), { target: { value: 'pinned' } })
  fireEvent.change(screen.getByLabelText('指定主廚模型'), { target: { value: 'codex:x' } })
  fireEvent.change(screen.getByLabelText('主廚任務目標'), { target: { value: 'Keep this goal' } })
  fireEvent.click(screen.getByText('交給主廚'))
  expect((await screen.findByRole('alert')).textContent).toBe('Workspace busy')
  expect((screen.getByLabelText('主廚任務目標') as HTMLTextAreaElement).value).toBe('Keep this goal')
  expect(manageChef).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({ mode: 'pinned', preferred: 'codex:x' }) }))
})
