// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ErrorIntakeManager } from '../src/renderer/components/ErrorIntakeManager.js'
import type { ErrorIntakeRequest, ErrorIntakeResponse } from '../src/shared/error-intake.js'
import type { ProjectView } from '../src/shared/projects.js'

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(cleanup)

const settingsResponse: ErrorIntakeResponse = {
  kind: 'settings',
  settings: { host: 'db.test', port: 3306, database: 'errors', tls: true, adminUsername: 'root', hasAdminPassword: true, hasAppPassword: false, schemaVersion: null, packageSource: '@yeschef/error-intake' },
}
const statusResponse: ErrorIntakeResponse = {
  kind: 'status', status: { connected: true, passwordNeedsReentry: false, schemaVersion: 1, lastCleanupAt: '2026-10-01T08:00:00.000Z', lastCleanup: { ok: true, deletedEvents: 4, deletedGroups: 2, message: '清理完成' } },
}

it('載入資料庫狀態並儲存空白密碼時不覆寫既有密碼', async () => {
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    return settingsResponse
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} onClose={() => {}} />)
  expect(await screen.findByRole('dialog', { name: '錯誤收集資料庫' })).not.toBeNull()
  expect(await screen.findByText('可連線')).not.toBeNull()
  expect(screen.getByLabelText('管理者密碼').getAttribute('placeholder')).toBe('已設定，留空表示不變更')
  fireEvent.change(screen.getByLabelText('主機'), { target: { value: 'db-new.test' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({
    action: 'save', settings: { host: 'db-new.test', port: 3306, database: 'errors', tls: true, adminUsername: 'root', packageSource: '@yeschef/error-intake' },
  }))
})

it('連線並初始化前保存新設定，接著顯示初始化後狀態', async () => {
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    if (request.action === 'save') return settingsResponse
    return { kind: 'initialized', status: { connected: true, passwordNeedsReentry: false, schemaVersion: 1, lastCleanupAt: null, lastCleanup: null } }
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} onClose={() => {}} />)
  await screen.findByRole('dialog', { name: '錯誤收集資料庫' })
  fireEvent.change(screen.getByLabelText('管理者密碼'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: '連線並初始化' }))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith(expect.objectContaining({
    action: 'save', settings: expect.objectContaining({ adminPassword: 'secret' }),
  })))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({ action: 'initialize' }))
  expect(await screen.findByText('尚未執行')).not.toBeNull()
})

it('密碼密文無法解密時明確提示重輸入口，並以新密碼執行恢復', async () => {
  const needsPassword: ErrorIntakeResponse = {
    kind: 'status', status: { connected: false, passwordNeedsReentry: true, schemaVersion: null, lastCleanupAt: null, lastCleanup: null },
  }
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return needsPassword
    if (request.action === 'save') return settingsResponse
    return { kind: 'initialized', status: statusResponse.status }
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} onClose={() => {}} />)
  await screen.findByRole('dialog', { name: '錯誤收集資料庫' })
  expect(await screen.findByText('需要重新輸入密碼')).not.toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('請重新輸入管理者密碼')
  const password = screen.getByLabelText('管理者密碼（需要重新輸入）') as HTMLInputElement
  expect(password.placeholder).toBe('請重新輸入管理者密碼')
  expect(password.required).toBe(true)
  fireEvent.change(password, { target: { value: 'new-admin-password' } })
  fireEvent.click(screen.getByRole('button', { name: '重新輸入密碼並恢復' }))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith(expect.objectContaining({
    action: 'save', settings: expect.objectContaining({ adminPassword: 'new-admin-password' }),
  })))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({ action: 'initialize', recovery: true }))
})

// 實機：取消勾選 TLS 後整個畫面變黑。更新函式在事件結束後才執行，那時 event.currentTarget 已是 null。
it('取消勾選 TLS 不會讓畫面崩潰，儲存時帶 tls: false', async () => {
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    return settingsResponse
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} onClose={() => {}} />)
  const tls = await screen.findByRole('checkbox', { name: 'TLS' })
  await waitFor(() => expect((tls as HTMLInputElement).checked).toBe(true))
  fireEvent.click(tls)
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'TLS' }) as HTMLInputElement).checked).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({
    action: 'save', settings: { host: 'db.test', port: 3306, database: 'errors', tls: false, adminUsername: 'root', packageSource: '@yeschef/error-intake' },
  }))
})

const project = { id: 'p1', name: 'demo-app' } as unknown as ProjectView
const pendingProject: Extract<ErrorIntakeResponse, { kind: 'project' }> = {
  kind: 'project', projectId: 'p1', folderName: 'demo-app', defaultProjectCode: 'demo-app',
  enabled: false, projectCode: null, projectCodeLocked: false, databaseReady: true,
}

it('沒有前景專案時不要求啟用，資料庫未初始化時按鈕停用', async () => {
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    if (request.action === 'project') return { ...pendingProject, databaseReady: false }
    return { kind: 'error', message: 'unexpected' }
  })
  const { rerender } = render(<ErrorIntakeManager api={{ manageErrorIntake }} onClose={() => {}} />)
  expect(await screen.findByText('目前沒有開啟的專案')).not.toBeNull()
  expect(manageErrorIntake.mock.calls.some(([request]) => request.action === 'project')).toBe(false)
  rerender(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  expect(await screen.findByDisplayValue('demo-app')).not.toBeNull()
  expect(screen.getByText('請先初始化錯誤資料庫並確認版本正確。')).not.toBeNull()
  expect((screen.getByRole('button', { name: '啟用錯誤收集' }) as HTMLButtonElement).disabled).toBe(true)
})

it('確認模型供應商提醒後呼叫啟用 IPC，使用者編輯套件來源會一併傳入', async () => {
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    if (request.action === 'project') return pendingProject
    if (request.action === 'enable') return { kind: 'enabled', projectId: request.projectId, projectCode: request.projectCode, taskId: 'task-1' }
    return { kind: 'error', message: 'unexpected' }
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  const code = await screen.findByDisplayValue('demo-app')
  expect((code as HTMLInputElement).disabled).toBe(false)
  const enable = screen.getByRole('button', { name: '啟用錯誤收集' })
  expect((enable as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '我了解拉錯誤交給主廚時，錯誤內容會送到模型供應商' }))
  expect((enable as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText('套件來源'), { target: { value: '/tmp/error-intake.tgz' } })
  fireEvent.click(enable)
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({
    action: 'enable', projectId: 'p1', projectCode: 'demo-app', acknowledged: true, packageSource: '/tmp/error-intake.tgz',
  }))
})

it('已啟用時顯示環境變數名稱，複製只呼叫 IPC 並不把連線值放進回應或畫面', async () => {
  const enabledProject: Extract<ErrorIntakeResponse, { kind: 'project' }> = {
    ...pendingProject, enabled: true, projectCode: 'orders-api',
  }
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    if (request.action === 'project') return enabledProject
    if (request.action === 'copy-connection') return { kind: 'copied', projectId: request.projectId }
    return { kind: 'error', message: 'unexpected' }
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  expect((await screen.findByDisplayValue('orders-api') as HTMLInputElement).disabled).toBe(true)
  for (const name of ['ERROR_INTAKE_DATABASE_URL', 'ERROR_INTAKE_PROJECT', 'APP_ENV']) expect(screen.getByText(name)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '複製連線字串' }))
  await waitFor(() => expect(manageErrorIntake).toHaveBeenCalledWith({ action: 'copy-connection', projectId: 'p1' }))
  expect(screen.getByText('已複製連線字串')).not.toBeNull()
  expect(document.body.textContent).not.toContain('mysql://')
})

it('帳號已建立但任務尚未啟用時，沿用並鎖定原專案代號', async () => {
  const projectWithWriter: Extract<ErrorIntakeResponse, { kind: 'project' }> = {
    ...pendingProject, projectCode: 'chosen-code', projectCodeLocked: true,
  }
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') return statusResponse
    if (request.action === 'project') return projectWithWriter
    return { kind: 'error', message: 'unexpected' }
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  expect((await screen.findByDisplayValue('chosen-code') as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('此專案已有寫入帳號，會沿用既有代號。')).not.toBeNull()
})

// 實機驗收：第一次設定時初始化成功，「啟用錯誤收集」仍停用，要關掉對話框重開才能按。
it('初始化成功後不用重開對話框，啟用按鈕就能按', async () => {
  let initialized = false
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get' || request.action === 'save') return settingsResponse
    if (request.action === 'status') return initialized ? statusResponse : { kind: 'status', status: { connected: true, passwordNeedsReentry: false, schemaVersion: null, lastCleanupAt: null, lastCleanup: null } }
    if (request.action === 'project') return { ...pendingProject, databaseReady: initialized }
    if (request.action === 'initialize') { initialized = true; return { kind: 'initialized', status: statusResponse.status } }
    return settingsResponse
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /模型供應商/ }))
  expect((screen.getByRole('button', { name: '啟用錯誤收集' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '連線並初始化' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '啟用錯誤收集' }) as HTMLButtonElement).disabled).toBe(false))
})

// 資料庫狀態比專案狀態晚回來時，schema 版本從未知變成 1 會觸發重讀；使用者已勾的確認不能因此被清掉。
it('資料庫狀態晚到觸發重讀時，已勾選的確認仍保留', async () => {
  let releaseStatus: () => void = () => {}
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve })
  const manageErrorIntake = vi.fn(async (request: ErrorIntakeRequest): Promise<ErrorIntakeResponse> => {
    if (request.action === 'get') return settingsResponse
    if (request.action === 'status') { await statusGate; return statusResponse }
    if (request.action === 'project') return pendingProject
    return settingsResponse
  })
  render(<ErrorIntakeManager api={{ manageErrorIntake }} project={project} onClose={() => {}} />)
  const consent = await screen.findByRole('checkbox', { name: /模型供應商/ })
  fireEvent.click(consent)
  releaseStatus()
  await waitFor(() => expect(manageErrorIntake.mock.calls.filter(([request]) => request.action === 'project').length).toBeGreaterThan(1))
  expect((screen.getByRole('checkbox', { name: /模型供應商/ }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('button', { name: '啟用錯誤收集' }) as HTMLButtonElement).disabled).toBe(false)
})
