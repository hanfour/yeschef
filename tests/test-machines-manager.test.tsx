// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TestMachinesManager } from '../src/renderer/components/TestMachinesManager.js'
import type { TestMachinesRequest, TestMachinesResponse } from '../src/shared/test-machines.js'

afterEach(cleanup)
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

const STAGING = { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa', hasPassword: true, passwordNeedsReentry: false }

function setup(initial: TestMachinesResponse = { kind: 'state', revision: 1, machines: [STAGING] }) {
  const requests: TestMachinesRequest[] = []
  let next: TestMachinesResponse = initial
  const api = {
    manageTestMachines: vi.fn(async (request: TestMachinesRequest) => { requests.push(request); return next }),
  }
  const onClose = vi.fn()
  render(<TestMachinesManager api={api} projectId="p1" projectName="yeschef" onClose={onClose} />)
  return { requests, onClose, reply: (r: TestMachinesResponse) => { next = r } }
}

describe('TestMachinesManager', () => {
  it('開啟時列出目前專案的測試機與密碼狀態', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    expect(requests[0]).toEqual({ action: 'list', projectId: 'p1' })
    expect(screen.getByText('https://staging.test/login')).toBeTruthy()
    expect(screen.getByText('已設定')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '測試機' })).toBeTruthy()
    expect(screen.getByText('yeschef 的測試機。agent 只能用 view_login 登入已設定的測試機，無法查看帳密。')).toBeTruthy()
    expect(screen.queryByText('yeschef', { selector: '.skills-eyebrow' })).toBeNull()
  })

  it('密碼密文失效時顯示重輸狀態並要求重新保存', async () => {
    const { requests } = setup({ kind: 'state', revision: 1, machines: [{ ...STAGING, hasPassword: false, passwordNeedsReentry: true }] })
    await screen.findByText('staging')
    expect(screen.getByText('需要重新輸入密碼')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新輸入 staging 的密碼' }))
    const password = screen.getByLabelText('密碼（需要重新輸入）') as HTMLInputElement
    expect(password.required).toBe(true)
    expect(password.placeholder).toBe('請重新輸入密碼')
    fireEvent.change(password, { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(requests.at(-1)).toEqual({
      action: 'upsert', projectId: 'p1', revision: 1,
      machine: { id: 'm1', name: 'staging', url: STAGING.url, username: 'qa', password: 'new-secret' },
    }))
  })

  it('切換專案時整個對話框重新掛載,重新載入新專案的清單', async () => {
    const requests: TestMachinesRequest[] = []
    const api = {
      manageTestMachines: vi.fn(async (request: TestMachinesRequest): Promise<TestMachinesResponse> => {
        requests.push(request)
        return request.projectId === 'p1'
          ? { kind: 'state', revision: 1, machines: [STAGING] }
          : { kind: 'state', revision: 5, machines: [] }
      }),
    }
    const { rerender } = render(<TestMachinesManager key="p1" api={api} projectId="p1" projectName="yeschef" onClose={() => {}} />)
    await screen.findByText('staging')
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '還沒存的草稿' } })
    rerender(<TestMachinesManager key="p2" api={api} projectId="p2" projectName="other" onClose={() => {}} />)
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'list', projectId: 'p2' }) })
    expect((screen.getByLabelText('名稱') as HTMLInputElement).value).toBe('')
    // key 不同會強制卸載重掛,所以無論修法前後都會是兩次;這裡只是連帶確認每個實例各呼叫一次 showModal。
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(2)
  })

  it('新增:四欄送 upsert,帶目前的 revision', async () => {
    const { requests, reply } = setup()
    await screen.findByText('staging')
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: 'uat' } })
    fireEvent.change(screen.getByLabelText('網址'), { target: { value: 'https://uat.test/' } })
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'tester' } })
    fireEvent.change(screen.getByLabelText('密碼'), { target: { value: 'pw' } })
    reply({ kind: 'state', revision: 2, machines: [STAGING, { id: 'm2', name: 'uat', url: 'https://uat.test/', username: 'tester', hasPassword: true, passwordNeedsReentry: false }] })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'upsert', projectId: 'p1', revision: 1, machine: { name: 'uat', url: 'https://uat.test/', username: 'tester', password: 'pw' } }) })
    await screen.findByText('uat')
    expect((screen.getByLabelText('密碼') as HTMLInputElement).value).toBe('')
  })

  it('編輯既有的:密碼留空就不送 password 欄位', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    fireEvent.click(screen.getByRole('button', { name: '編輯 staging' }))
    expect((screen.getByLabelText('密碼') as HTMLInputElement).placeholder).toBe('留空表示不變')
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'qa2' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'upsert', projectId: 'p1', revision: 1, machine: { id: 'm1', name: 'staging', url: 'https://staging.test/login', username: 'qa2' } }) })
  })

  it('刪除送 remove', async () => {
    const { requests } = setup()
    await screen.findByText('staging')
    fireEvent.click(screen.getByRole('button', { name: '刪除 staging' }))
    await waitFor(() => { expect(requests.at(-1)).toEqual({ action: 'remove', projectId: 'p1', revision: 1, id: 'm1' }) })
  })

  it('主行程回 error 就顯示在表單下方', async () => {
    const { reply } = setup()
    await screen.findByText('staging')
    reply({ kind: 'error', message: '這台電腦的鑰匙圈不可用，無法儲存密碼' })
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('網址'), { target: { value: 'https://x.test/' } })
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'u' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect((await screen.findByRole('alert')).textContent).toBe('這台電腦的鑰匙圈不可用，無法儲存密碼')
  })

  it('編輯既有的會清掉上一次殘留的錯誤訊息', async () => {
    const { reply } = setup()
    await screen.findByText('staging')
    reply({ kind: 'error', message: '這台電腦的鑰匙圈不可用，無法儲存密碼' })
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('網址'), { target: { value: 'https://x.test/' } })
    fireEvent.change(screen.getByLabelText('帳號'), { target: { value: 'u' } })
    fireEvent.click(screen.getByRole('button', { name: '儲存' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '編輯 staging' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('密碼欄是 password 型別', async () => {
    setup()
    await screen.findByText('staging')
    expect((screen.getByLabelText('密碼') as HTMLInputElement).type).toBe('password')
  })

  it('帳號欄不可留空(M2)', async () => {
    setup()
    await screen.findByText('staging')
    expect((screen.getByLabelText('帳號') as HTMLInputElement).required).toBe(true)
  })
})
