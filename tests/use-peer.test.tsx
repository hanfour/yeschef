// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { usePeer } from '../src/renderer/hooks/usePeer.js'
import type { PeerPendingView, YesChefApi } from '../src/shared/ipc.js'
import { createFakeYesChef } from './helpers/fake-yeschef.js'

afterEach(cleanup)

const item = (over: Partial<PeerPendingView> = {}): PeerPendingView => ({
  questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2',
  askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false, ...over,
})

function Probe({ api }: { api: YesChefApi }) {
  const peer = usePeer(api)
  return <><output data-testid="pending">{JSON.stringify(peer.pending)}</output>
    <button onClick={() => peer.answer('q1', '我幫他答')}>回答</button>
    <button onClick={() => peer.cancel('q1')}>取消</button></>
}

describe('usePeer', () => {
  it('一開始是空的', () => {
    render(<Probe api={createFakeYesChef().api} />)
    expect(screen.getByTestId('pending').textContent).toBe('[]')
  })
  it('收到推送就整份換掉', () => {
    const f = createFakeYesChef()
    render(<Probe api={f.api} />)
    f.emitPeer({ pending: [item()] })
    expect(screen.getByTestId('pending').textContent).toBe(JSON.stringify([item()]))
    f.emitPeer({ pending: [] })
    expect(screen.getByTestId('pending').textContent).toBe('[]')
  })
  it('兩個動作送出對應的 payload', () => {
    const f = createFakeYesChef()
    const answer = vi.spyOn(f.api, 'answerPeerAsUser')
    const cancel = vi.spyOn(f.api, 'cancelPeer')
    render(<Probe api={f.api} />)
    fireEvent.click(screen.getByRole('button', { name: '回答' }))
    expect(answer).toHaveBeenCalledWith({ questionId: 'q1', text: '我幫他答' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(cancel).toHaveBeenCalledWith({ questionId: 'q1' })
  })
  it('卸載解除訂閱', () => {
    const f = createFakeYesChef()
    const off = vi.fn()
    const original = f.api.onPeerState
    vi.spyOn(f.api, 'onPeerState').mockImplementation((cb) => {
      const unsubscribe = original(cb)
      return () => { off(); unsubscribe() }
    })
    const { unmount } = render(<Probe api={f.api} />)
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})

  it('掛載拉取已有未決問題,重載後仍可見', async () => {
    const f = createFakeYesChef()
    const get = vi.spyOn(f.api, 'getPeer').mockResolvedValue({ pending: [item()] })
    const first = render(<Probe api={f.api} />)
    await act(async () => {})
    expect(screen.getByTestId('pending').textContent).toBe(JSON.stringify([item()]))
    first.unmount()
    render(<Probe api={f.api} />)
    await act(async () => {})
    expect(get).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('pending').textContent).toBe(JSON.stringify([item()]))
  })

  it('晚回來的初始快照不覆蓋新推送', async () => {
    const f = createFakeYesChef()
    let resolve!: (state: { pending: readonly PeerPendingView[] }) => void
    vi.spyOn(f.api, 'getPeer').mockReturnValue(new Promise((done) => { resolve = done }))
    render(<Probe api={f.api} />)
    f.emitPeer({ pending: [] })
    await act(async () => { resolve({ pending: [item()] }) })
    expect(screen.getByTestId('pending').textContent).toBe('[]')
  })

  it('卸載後初始快照不影響下一次掛載', async () => {
    const f = createFakeYesChef()
    let resolve!: (state: { pending: readonly PeerPendingView[] }) => void
    vi.spyOn(f.api, 'getPeer').mockReturnValueOnce(new Promise((done) => { resolve = done }))
    render(<Probe api={f.api} />).unmount()
    render(<Probe api={f.api} />)
    await act(async () => { resolve({ pending: [item()] }) })
    expect(screen.getByTestId('pending').textContent).toBe('[]')
  })

  it('初始拉取失敗記錄錯誤,仍接受推送', async () => {
    const f = createFakeYesChef()
    const error = new Error('離線')
    vi.spyOn(f.api, 'getPeer').mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Probe api={f.api} />)
    await act(async () => {})
    expect(log).toHaveBeenCalledWith('讀取同伴提問失敗', error)
    f.emitPeer({ pending: [item()] })
    expect(screen.getByTestId('pending').textContent).toBe(JSON.stringify([item()]))
    log.mockRestore()
  })
