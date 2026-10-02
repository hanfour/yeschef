// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useGroup, type GroupApi } from '../src/renderer/hooks/useGroup.js'
import { GENERAL_THREAD_ID, type GroupMessage, type GroupThread } from '../src/shared/group.js'
import { createFakeYesChef } from './helpers/fake-yeschef.js'

afterEach(cleanup)

const message = (id: string, projectId = 'p1'): GroupMessage => ({
  id, projectId, threadId: 't1', at: 1, from: { kind: 'user' }, kind: 'text', text: `訊息 ${id}`, mentions: [],
})
const general: GroupThread = { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, holdsWorkspace: false, participants: [] }

function Probe({ api, projectId }: { api: GroupApi; projectId: string }) {
  const group = useGroup(api, projectId)
  return (
    <>
      <output data-testid="ids">{group.messages.map((m) => m.id).join(',')}</output>
      <output data-testid="threads">{group.threads.map((t) => t.id).join(',')}</output>
      <output data-testid="loaded">{String(group.loaded)}</output>
      <output data-testid="error">{group.error ?? ''}</output>
      <button onClick={() => void group.send('t1', '哈囉')}>送出</button>
    </>
  )
}

describe('useGroup', () => {
  it('先訂閱再 get,載入期間到達的推播不會漏掉', async () => {
    const fake = createFakeYesChef()
    const order: string[] = []
    let resolveGet!: (response: Awaited<ReturnType<GroupApi['manageGroup']>>) => void
    const original = fake.api.onGroupMessages
    vi.spyOn(fake.api, 'onGroupMessages').mockImplementation((cb) => {
      order.push('subscribe')
      return original(cb)
    })
    vi.spyOn(fake.api, 'manageGroup').mockImplementation(() => {
      order.push('get')
      return new Promise((resolve) => { resolveGet = resolve })
    })
    render(<Probe api={fake.api} projectId="p1" />)
    expect(order).toEqual(['subscribe', 'get'])
    fake.emitGroup({ projectId: 'p1', messages: [message('b')], threads: [general] })
    expect(screen.getByTestId('ids').textContent).toBe('b')
    await act(async () => {
      resolveGet({ kind: 'state', messages: [message('a'), message('b')], threads: [general] })
    })
    expect(screen.getByTestId('ids').textContent).toBe('a,b')
  })

  it('載入期間推播較新的 threads 時,不被較舊的 get 蓋掉', async () => {
    const fake = createFakeYesChef()
    let resolveGet!: (response: Awaited<ReturnType<GroupApi['manageGroup']>>) => void
    vi.spyOn(fake.api, 'manageGroup').mockImplementation(() => new Promise((resolve) => { resolveGet = resolve }))
    render(<Probe api={fake.api} projectId="p1" />)
    const task: GroupThread = { id: 'new', title: '新目標', status: 'open', createdAt: 10, holdsWorkspace: false, participants: [] }
    fake.emitGroup({ projectId: 'p1', messages: [], threads: [general, task] })

    await act(async () => {
      resolveGet({ kind: 'state', messages: [], threads: [general] })
    })

    expect(screen.getByTestId('threads').textContent).toBe(`${GENERAL_THREAD_ID},new`)
  })

  it('掛載就呼叫 get,把結果放進來', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    expect(screen.getByTestId('threads').textContent).toBe(GENERAL_THREAD_ID)
    expect(screen.getByTestId('loaded').textContent).toBe('true')
    expect(fake.api.manageGroup).toHaveBeenCalledWith({ action: 'get', projectId: 'p1' })
  })

  it('推播的訊息接在後面,thread 整份換掉,重複的 id 不會進來兩次', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    const task: GroupThread = { id: 't1', title: '補測試', status: 'running', createdAt: 10, holdsWorkspace: true, participants: [] }
    fake.emitGroup({ projectId: 'p1', messages: [message('b')], threads: [general, task] })
    expect(screen.getByTestId('ids').textContent).toBe('a,b')
    expect(screen.getByTestId('threads').textContent).toBe(`${GENERAL_THREAD_ID},t1`)
    fake.emitGroup({ projectId: 'p1', messages: [message('b'), message('c'), message('c')], threads: [general, task] })
    expect(screen.getByTestId('ids').textContent).toBe('a,b,c')
  })

  it('別的專案的推播不進來', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'))
    fake.emitGroup({ projectId: 'p2', messages: [message('x', 'p2')], threads: [] })
    expect(screen.getByTestId('ids').textContent).toBe('')
  })

  it('換專案時清空並重新載入', async () => {
    const fake = createFakeYesChef()
    const manage = vi.spyOn(fake.api, 'manageGroup')
    manage.mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    const { rerender } = render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    manage.mockResolvedValue({ kind: 'state', messages: [message('z', 'p2')], threads: [general] })
    rerender(<Probe api={fake.api} projectId="p2" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('z'))
    expect(manage).toHaveBeenLastCalledWith({ action: 'get', projectId: 'p2' })
  })

  it('send 在換專案後回 error 不會污染新專案狀態', async () => {
    const fake = createFakeYesChef()
    const manage = vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [], threads: [general] })
    const { rerender } = render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'))

    let resolveSend!: (response: Awaited<ReturnType<GroupApi['manageGroup']>>) => void
    const sendResponse = new Promise<Awaited<ReturnType<GroupApi['manageGroup']>>>((resolve) => { resolveSend = resolve })
    manage.mockImplementation((request) => request.action === 'send' ? sendResponse : Promise.resolve({ kind: 'state', messages: [], threads: [general] }))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(manage).toHaveBeenLastCalledWith({ action: 'send', projectId: 'p1', threadId: 't1', text: '哈囉' })

    rerender(<Probe api={fake.api} projectId="p2" />)
    await waitFor(() => expect(manage).toHaveBeenLastCalledWith({ action: 'get', projectId: 'p2' }))
    await act(async () => {
      resolveSend({ kind: 'error', message: '舊專案錯誤' })
    })

    expect(screen.getByTestId('error').textContent).toBe('')
  })

  it('send 送 action send;回 error 時顯示訊息', async () => {
    const fake = createFakeYesChef()
    const manage = vi.spyOn(fake.api, 'manageGroup')
    manage.mockResolvedValue({ kind: 'state', messages: [], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'))
    manage.mockResolvedValue({ kind: 'sent', threadId: 't1' })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(manage).toHaveBeenLastCalledWith({ action: 'send', projectId: 'p1', threadId: 't1', text: '哈囉' }))
    expect(screen.getByTestId('error').textContent).toBe('')
    manage.mockResolvedValue({ kind: 'error', message: '找不到這個專案' })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('找不到這個專案'))
  })

  it('get 失敗時顯示錯誤,仍然算載入完成', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockRejectedValue(new Error('IPC 掛了'))
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('IPC 掛了'))
    expect(screen.getByTestId('loaded').textContent).toBe('true')
  })

  it('卸載解除訂閱', async () => {
    const fake = createFakeYesChef()
    const off = vi.fn()
    const original = fake.api.onGroupMessages
    vi.spyOn(fake.api, 'onGroupMessages').mockImplementation((cb) => {
      const unsubscribe = original(cb)
      return () => { off(); unsubscribe() }
    })
    const { unmount } = render(<Probe api={fake.api} projectId="p1" />)
    await act(async () => {})
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
