// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChefManager } from '../src/renderer/components/ChefManager.js'
import type { ChefRequest, ChefResponse, ChefTask } from '../src/shared/chef.js'
import type { ProjectsView } from '../src/shared/projects.js'
beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(cleanup)
const projects: ProjectsView = { activeId: 'p', projects: [{ id: 'p', name: 'Test', rootPath: '/test', available: true, pendingApproval: false, pendingTabIds: [], busyTabIds: [], producingTabIds: [], busySince: {}, tabs: [], threads: [], activeTabId: '' }] }
const state: ChefResponse = { kind: 'state', state: { tasks: [], notices: [], unavailableModels: [], models: [{ key: 'claude:c', provider: 'claude', model: 'c', label: 'C', description: '', recommended: true }, { key: 'codex:x', provider: 'codex', model: 'x', label: 'X', description: '', recommended: true }] } }
const uiTask = (withUiCheck: boolean): ChefTask => ({
  id: 'task-1', projectId: 'p', cwd: '/test', goal: '介面工作', followups: [],
  policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 6, deadlineMinutes: 30 },
  status: 'completed', createdAt: 0, deadlineAt: 1, units: [], attempts: [], reason: '完成', cancelRequested: false, needsReconciliation: false,
  ...(withUiCheck ? {
    uiCheck: { files: ['src/Card.css'], identities: [{ key: 'a'.repeat(64), id: 'F1' }], findings: [{ id: 'F1', stableKey: 'a'.repeat(64), ruleId: 'tiny-text', severity: 'error', description: '文字至少使用 11px。', path: 'src/Card.css', line: 4, snippet: 'font-size: 10px;' }] },
    report: { unitId: 'review-1', outcome: 'completed', summary: '完成', checks: [], uiFindings: [{ id: 'F1', resolution: 'fixed', reason: '已調整字級' }] },
  } : {}),
})
const stateWithTask = (task: ChefTask): ChefResponse => ({ kind: 'state', state: { ...state.state, tasks: [task] } })
it('模型池標示帳號不支援的模型，同時保留可操作的勾選框', async () => {
  const expiresAt = new Date(2026, 9, 2, 14, 5).getTime()
  const response: ChefResponse = { kind: 'state', state: { ...state.state, unavailableModels: [{ key: 'codex:x', expiresAt }] } }
  const manageChef = vi.fn(async (): Promise<ChefResponse> => response)
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} onClose={() => {}} />)
  await screen.findByText('Codex · X')
  fireEvent.click(screen.getByText('模型池與執行上限（2 個模型）'))
  expect(screen.getByText('帳號不支援，2026/10/02 14:05 前暫不選用')).toBeTruthy()
  const checkbox = screen.getByRole('checkbox', { name: /Codex · X/ }) as HTMLInputElement
  expect(checkbox.checked).toBe(true)
  expect(checkbox.disabled).toBe(false)
  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(false)
})
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

it('任務詳情顯示介面發現與回報處理原因', async () => {
  const response = stateWithTask(uiTask(true))
  const manageChef = vi.fn(async (): Promise<ChefResponse> => response)
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} selectedTaskId="task-1" onClose={() => {}} />)
  expect(await screen.findByRole('heading', { name: '介面檢查' })).toBeTruthy()
  expect(screen.getByText('F1 · tiny-text')).toBeTruthy()
  expect(screen.getByText(/原因：已調整字級/)).toBeTruthy()
  expect(screen.getByText(/錯誤 · 已修正/)).toBeTruthy()
})

it('任務詳情分開顯示待處理、已略過與缺少原因的註解', async () => {
  const task: ChefTask = {
    ...uiTask(false),
    uiCheck: {
      files: ['src/Card.css'],
      identities: [],
      findings: [{ id: 'F1', stableKey: 'a'.repeat(64), ruleId: 'tiny-text', severity: 'error', description: '文字至少使用 11px。', path: 'src/Card.css', line: 4, snippet: 'font-size: 10px;' }],
      skipped: [{ ruleId: 'pure-black-white', severity: 'warning', description: '避免使用純黑或純白背景。', path: 'src/Card.css', line: 8, snippet: 'background-color: #fff;', reason: '品牌需求' }],
      invalidIgnores: [{ ruleId: 'tiny-text', path: 'src/Card.css', line: 2, snippet: 'yeschef-ui-ignore tiny-text:' }],
    },
  }
  const manageChef = vi.fn(async (): Promise<ChefResponse> => stateWithTask(task))
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} selectedTaskId="task-1" onClose={() => {}} />)
  await screen.findByRole('heading', { name: '介面檢查' })
  expect(screen.getByRole('heading', { name: '需要處理' })).toBeTruthy()
  expect(screen.getByText('F1 · tiny-text')).toBeTruthy()
  expect(screen.getByRole('heading', { name: '已略過' })).toBeTruthy()
  expect(screen.getByText('pure-black-white')).toBeTruthy()
  expect(screen.getByText(/原因：品牌需求/)).toBeTruthy()
  expect(screen.queryByText(/F\d+ · pure-black-white/)).toBeNull()
  expect(screen.getByRole('heading', { name: '略過註解缺少原因' })).toBeTruthy()
  expect(screen.getByText('未生效')).toBeTruthy()
  expect(screen.getByText('這個略過註解缺少原因，因此規則仍會檢查。')).toBeTruthy()
})

it('沒有掃描範圍時不顯示介面檢查區', async () => {
  const response = stateWithTask(uiTask(false))
  const manageChef = vi.fn(async (): Promise<ChefResponse> => response)
  render(<ChefManager api={{ manageChef, activateTab: vi.fn() }} projects={projects} selectedTaskId="task-1" onClose={() => {}} />)
  await screen.findByRole('status')
  expect(screen.queryByRole('heading', { name: '介面檢查' })).toBeNull()
})
