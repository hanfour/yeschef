// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PermissionManager } from '../src/renderer/components/PermissionManager.js'
import { emptyPolicy, type PermissionAudit, type PermissionsRequest, type PermissionsResponse, type PermissionState } from '../src/shared/permissions.js'
beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(cleanup)
function setup(options: { audit?: PermissionAudit[]; onExport?: (projectId: string) => PermissionsResponse } = {}) {
  let state: PermissionState = { revision: 0, paused: false, policies: [] }
  const audit = options.audit ?? []
  const managePermissions = vi.fn(async (request: PermissionsRequest): Promise<PermissionsResponse> => {
    if (request.action === 'save') state = { ...state, revision: state.revision + 1, policies: [request.policy] }
    if (request.action === 'pause') state = { ...state, revision: state.revision + 1, paused: request.paused }
    if (request.action === 'export') return options.onExport?.(request.projectId) ?? { kind: 'exported', path: '/tmp/yeschef-授權紀錄-p-2026-09-24.json' }
    return { kind: 'state', state, audit }
  })
  render(<PermissionManager api={{ managePermissions }} activeId="p" projects={[{ id: 'p', name: 'Project' }, { id: 'q', name: 'Other' }]} onClose={() => {}} onChange={() => {}} />)
  return managePermissions
}
let auditSeq = 0
function makeAudit(overrides: Partial<PermissionAudit> = {}): PermissionAudit {
  auditSeq += 1
  return { id: `a${auditSeq}`, at: new Date(2026, 0, auditSeq).toISOString(), projectId: 'p', conversationId: 'conversation-id', tool: 'Write', decision: 'allow', source: 'rule', reason: '符合專案檔案授權', revision: 1, requestHash: 'h', ...overrides }
}
it('預設人工；選擇模式不立即授權，儲存才套用，未存草稿不被刷新紀錄清掉', async () => {
  const manage = setup(); await waitFor(() => expect((screen.getByRole('radio', { name: /規則自動/ }) as HTMLInputElement).disabled).toBe(false))
  expect(screen.getByRole('heading', { name: '讓批准符合你的工作方式' })).toBeTruthy()
  expect(screen.getByText('明確授權的檔案操作自動處理，其他操作交給你。')).toBeTruthy()
  expect(screen.queryByText('YESCHEF · 授權與審核')).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: /規則自動/ }))
  fireEvent.click(screen.getByLabelText('新增與修改工作目錄內的檔案'))
  expect(manage.mock.calls.some(([r]) => r.action === 'save')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '重新整理紀錄' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '儲存授權設定' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByRole('radio', { name: /規則自動/ }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '儲存授權設定' }))
  await screen.findByText(/設定已儲存/)
  expect(manage).toHaveBeenCalledWith({ action: 'save', revision: 0, policy: { ...emptyPolicy('p'), mode: 'rules', write: true } })
})
it('審核模式顯示目的、範圍與用量說明；可暫停並恢復', async () => {
  const manage = setup(); await screen.findByText('此專案尚無審核紀錄。')
  fireEvent.click(screen.getByRole('radio', { name: /Agent 審核/ }))
  expect(screen.getByLabelText('審核目的')).not.toBeNull()
  expect(screen.getByText(/US\$0.25/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '暫停所有自動批准' }))
  await screen.findByRole('button', { name: '恢復自動批准' })
  expect(manage).toHaveBeenCalledWith({ action: 'pause', revision: 0, paused: true })
})
it('顯示允許/拒絕/轉人工計數，可依決定篩選，摘要與未記錄皆正確呈現', async () => {
  const audit = [
    makeAudit({ id: 'allow-1', tool: 'Write', decision: 'allow', summary: '/repo/a.ts' }),
    makeAudit({ id: 'deny-1', tool: 'Bash', decision: 'deny', summary: 'echo hi' }),
    makeAudit({ id: 'manual-1', tool: 'Edit', decision: 'manual', summary: undefined }),
    makeAudit({ id: 'other-project', projectId: 'q', decision: 'allow', summary: '/other/x.ts' }),
  ]
  setup({ audit })
  await screen.findByText('允許 1 · 拒絕 1 · 轉人工 1')
  expect(screen.getByText('/repo/a.ts')).not.toBeNull()
  expect(screen.getByText('echo hi')).not.toBeNull()
  expect(screen.getByText('（未記錄）')).not.toBeNull()
  expect(screen.queryByText('/other/x.ts')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '拒絕' }))
  expect(screen.queryByText('/repo/a.ts')).toBeNull()
  expect(screen.getByText('echo hi')).not.toBeNull()
  expect(screen.queryByText('（未記錄）')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  expect(screen.getByText('/repo/a.ts')).not.toBeNull()
})
it('顯示超過 30 筆審核紀錄，不再只顯示最後 30 筆', async () => {
  const audit = Array.from({ length: 35 }, (_, i) => makeAudit({ id: `bulk-${i}`, summary: `/repo/file-${i}.ts` }))
  setup({ audit })
  await screen.findByText('允許 35 · 拒絕 0 · 轉人工 0')
  expect(screen.getByText('/repo/file-0.ts')).not.toBeNull()
  expect(screen.getByText('/repo/file-34.ts')).not.toBeNull()
})
it('匯出 JSON 呼叫 export action 並顯示已儲存路徑；取消不顯示路徑', async () => {
  const manage = setup({ onExport: projectId => ({ kind: 'exported', path: `/Users/demo/yeschef-授權紀錄-${projectId}-2026-09-24.json` }) })
  await screen.findByText('此專案尚無審核紀錄。')
  fireEvent.click(screen.getByRole('button', { name: '匯出 JSON' }))
  await screen.findByText(/yeschef-授權紀錄-p-2026-09-24\.json/)
  expect(manage).toHaveBeenCalledWith({ action: 'export', projectId: 'p' })
  cleanup()
  const manageCancelled = setup({ onExport: () => ({ kind: 'state', state: { revision: 0, paused: false, policies: [] }, audit: [] }) })
  await screen.findByText('此專案尚無審核紀錄。')
  fireEvent.click(screen.getByRole('button', { name: '匯出 JSON' }))
  await waitFor(() => expect(manageCancelled).toHaveBeenCalledWith({ action: 'export', projectId: 'p' }))
  expect(screen.queryByText(/\.json/)).toBeNull()
})
