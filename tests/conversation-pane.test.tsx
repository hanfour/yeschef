// @vitest-environment jsdom
import { ASK_PEER_TOOL, formatPeerInjection } from '../src/shared/peer-tools.js'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useProjects } from '../src/renderer/hooks/useProjects.js'
import { ConversationPane } from '../src/renderer/components/ConversationPane.js'
import { createFakeYesChef, fakeProjects, ONE_PROJECT, projectView } from './helpers/fake-yeschef.js'

import type { ConversationCost } from '../src/renderer/format-cost.js'
import type { ConversationView } from '../src/shared/fold.js'
import type { ApprovalAskPayload, PeerPendingView } from '../src/shared/ipc.js'

const ask = (over: Partial<ApprovalAskPayload>): ApprovalAskPayload => ({
  requestId: 'r1', projectId: 'p1', conversationId: 'c1', toolName: 'Bash',
  toolUseId: 'tu1', input: {}, title: '執行 ls', ...over,
})

const PEER_PROJECTS = {
  activeId: 'p1',
  projects: [
    projectView('p1', { name: 'proj5', activeTabId: 'c1', tabs: [
      { id: 'c1', contentType: 'conversation', label: 'A', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'p1-th' },
      { id: 'c2', contentType: 'conversation', label: 'B', customLabel: null, sortOrder: 1, lastFocusedAt: 0, threadId: 'p1-th' },
    ] }),
    projectView('p2'),
  ],
} satisfies import('../src/shared/projects.js').ProjectsView

afterEach(cleanup)
afterEach(() => { vi.useRealTimers() })

describe('ConversationPane', () => {
  it('將執行者與專案名稱放在空白對話的說明文字', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />)
    expect(screen.getByRole('heading', { name: '從一個想法開始' })).toBeTruthy()
    expect(screen.getByText('在「demo」專案中與 Claude 開始對話。描述你想完成的事，讓 agent 和你一起推進。')).toBeTruthy()
    expect(screen.queryByText('CLAUDE · demo')).toBeNull()
  })

  it('沒有專案的空白對話只在說明中標示執行者', () => {
    const fake = createFakeYesChef()
    const { projects } = fakeProjects({ activeId: null, projects: [] })
    render(<ConversationPane isActive api={fake.api} projects={projects} projectId="unassigned" conversationId="unassigned-conv" provider="claude" />)
    expect(screen.getByText('與 Claude 開始對話。描述你想完成的事，讓 agent 和你一起推進。')).toBeTruthy()
    expect(screen.queryByText(/YESCHEF/)).toBeNull()
  })

  it('codex 分頁的側邊欄畫 Recents', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(container.querySelector('.recents')).not.toBeNull()
    expect(screen.queryByText('codex 的歷史清單還沒做')).toBeNull()
  })

  it('claude 分頁的側邊欄畫 Recents,沒有說明句', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    expect(container.querySelector('.recents')).not.toBeNull()
    expect(screen.queryByText('codex 的歷史清單還沒做')).toBeNull()
  })

  it('codex 分頁在輸入框旁有「新對話」,claude 分頁沒有(它在 Recents 側欄裡)', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container, rerender } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    expect(container.querySelector('.composer-new')).not.toBeNull()
    rerender(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    expect(container.querySelector('.composer-new')).toBeNull()
  })

  it('按 codex 分頁的「新對話」會呼叫 startNew', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(<ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />)
    const button = screen.getAllByRole('button', { name: '新對話' }).find((node) => node.classList.contains('composer-new'))
    if (button === undefined) throw new Error('找不到輸入框的新對話按鈕')
    fireEvent.click(button)
    expect(fake.calls).toContain('startNew')
  })

  it('codex 分頁查詢時帶 provider,切換 provider 重新查詢', async () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const listSessions = vi.fn(async () => [])
    const api = { ...fake.api, listSessions }
    const { rerender } = render(
      <ConversationPane isActive={true} api={api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    await act(async () => { await Promise.resolve() })
    expect(listSessions).toHaveBeenLastCalledWith({ projectId: 'p-1', provider: 'codex' })
    rerender(
      <ConversationPane isActive={true} api={api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    await act(async () => { await Promise.resolve() })
    expect(listSessions).toHaveBeenLastCalledWith({ projectId: 'p-1', provider: 'claude' })
  })

  it('切到 codex 時保留側邊欄、輸入框與 Recents 清單', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container, rerender } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    expect(container.querySelector('.sidebar')).not.toBeNull()
    rerender(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(container.querySelector('.recents')).not.toBeNull()
    expect(screen.queryByText('codex 的歷史清單還沒做')).toBeNull()
    expect(container.querySelector('.composer-input')).not.toBeNull()
  })

  it('兩個 pane 各只收自己 conversationId 的事件', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(
      <>
        <div data-testid="pane-1">
          <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
        </div>
        <div data-testid="pane-2">
          <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv2" provider="claude" />
        </div>
      </>
    )
    fake.emitEvents([{ kind: 'user-text', text: '給一號的' }], 'p-1-conv')
    fake.emitEvents([{ kind: 'user-text', text: '給二號的' }], 'p-1-conv2')
    expect(screen.getByTestId('pane-1').textContent).toContain('給一號的')
    expect(screen.getByTestId('pane-1').textContent).not.toContain('給二號的')
    expect(screen.getByTestId('pane-2').textContent).toContain('給二號的')
    expect(screen.getByTestId('pane-2').textContent).not.toContain('給一號的')
  })

  it('批准卡也出現在別的 pane,輸入框只在自己的 pane 停用', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(
      <>
        <div data-testid="pane-1">
          <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
        </div>
        <div data-testid="pane-2">
          <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv2" provider="claude" />
        </div>
      </>
    )
    fake.emitAsk({ requestId: 'r1', projectId: 'p-1', conversationId: 'p-1-conv2', toolUseId: 't1', toolName: 'Bash', input: { command: 'rm x' } })
    const inputs = screen.getAllByLabelText('輸入訊息') as HTMLTextAreaElement[]
    expect(inputs[0]?.disabled).toBe(false)
    expect(inputs[1]?.disabled).toBe(true)
    expect(screen.getByTestId('pane-2').querySelector('.approval-tail, .approval-card')).not.toBeNull()
    expect(screen.getByTestId('pane-1').querySelector('.approval-origin')).not.toBeNull()
  })
})


describe('別的對話的批准卡', () => {
  it('畫在自己的卡片之後,標示是專案名加對話標籤', async () => {
    const fake = createFakeYesChef({ projects: PEER_PROJECTS })
    const { projects } = fakeProjects(PEER_PROJECTS)
    render(<ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="codex" />)
    fake.emitAsk(ask({ requestId: 'other', conversationId: 'c2', projectId: 'p1' }))
    fake.emitAsk(ask({ requestId: 'mine', conversationId: 'c1' }))
    const cards = await screen.findAllByTestId('approval-card')
    expect(cards).toHaveLength(2)
    expect(cards.map((card) => card.getAttribute('data-request-id'))).toEqual(['mine', 'other'])
    expect(screen.getByTestId('approval-origin').textContent).toContain('proj5 · B')
  })

  it('跨專案點標示先切專案,第二則 IPC 帶目標專案的 projectId', async () => {
    const fake = createFakeYesChef({ projects: PEER_PROJECTS })
    function Harness() {
      const projects = useProjects(fake.api)
      return <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="codex" />
    }
    render(<Harness />)
    fake.emitAsk(ask({ requestId: 'other', conversationId: 'p2-conv', projectId: 'p2' }))
    await waitFor(() => expect(screen.getByTestId('approval-origin').textContent).toContain('p2 · Claude 對話'))
    // 不推送新的 projects view,讓 hook 在兩則 IPC 之間保留舊 activeId=p1。
    fireEvent.click(screen.getByTestId('approval-origin'))
    expect(fake.calls).toEqual(['activateProject:p2', 'activateTab:p2:p2-conv'])
  })

  it('找不到對應的專案或分頁時標示退成「其他對話」', () => {
    const fake = createFakeYesChef({ projects: PEER_PROJECTS })
    const { projects } = fakeProjects(PEER_PROJECTS)
    render(<ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="codex" />)
    fake.emitAsk(ask({ requestId: 'other', conversationId: 'nope', projectId: 'nope' }))
    expect(screen.getByTestId('approval-origin').textContent).toContain('其他對話')
  })
})

it('回答方那一輪接上人的動作,整份快照清空就移除按鈕,歷史與別的回答方不給操作', () => {
  const f = createFakeYesChef()
  const { projects } = fakeProjects(PEER_PROJECTS)
  render(<ConversationPane isActive={true} api={f.api} projects={projects} projectId="p1" conversationId="c2" provider="codex" />)
  f.emitEvents([{ kind: 'user-text', text: formatPeerInjection({ provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'q1', text: '在嗎' }) }], 'c2')
  const item = { questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  f.emitPeer({ pending: [item] })
  fireEvent.click(screen.getByRole('button', { name: '代替回答' }))
  fireEvent.change(screen.getByRole('textbox', { name: '代替回答的內容' }), { target: { value: '我幫他答' } })
  fireEvent.click(screen.getAllByRole('button', { name: '送出' })[0]!)
  expect(f.calls).toContain('answerPeerAsUser:q1:我幫他答')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(f.calls).toContain('cancelPeer:q1')
  f.emitPeer({ pending: [] })
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  f.emitPeer({ pending: [{ ...item, targetConversationId: 'c1' }] })
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  f.emitPeer({ pending: [item] })
  f.emitState({ kind: 'viewing', sessionId: 's1' }, 'c2')
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
})

describe('提問方那側的介入', () => {
  it.each([ASK_PEER_TOOL, 'ask_peer'])('%s 執行中且自己是提問方時,底下畫兩顆按鈕', async (name) => {
    const rig = renderPane({
      conversationId: 'c1',
      view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name, input: {}, status: 'running' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }],
    })
    expect(await screen.findByRole('button', { name: '代替回答' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(rig.api.cancelPeer).toHaveBeenCalledWith({ questionId: 'q1' })
  })

  it('自己不是提問方時不畫按鈕', async () => {
    renderPane({
      conversationId: 'c1',
      view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name: ASK_PEER_TOOL, input: {}, status: 'running' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'cX', targetConversationId: 'c2', askerLinkId: 'bbbb2222', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }],
    })
    expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  })

  it('回答方那一輪的等待秒數依 createdAt 算', () => {
    const now = 1_000_000
    renderPane({
      conversationId: 'c2',
      now,
      view: { turns: [{ role: 'user', blocks: [{ kind: 'peer-question', questionId: 'q1', fromLinkId: 'aaaa1111', provider: 'claude', text: '在嗎' }] }] },
      peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: now - 42_000, queued: false }],
    })
    expect(screen.getByTestId('peer-status').textContent).toContain('等你回答，對方已等 42 秒')
  })
})

/** 沿用既有 fake-yeschef 的事件來源,把 brief 的 view 送進真實 fold 路徑。 */
function renderPane({ conversationId = 'c1', view, peerPending = [], now, provider = 'codex', isActive = true, onCost }: {
  conversationId?: string
  isActive?: boolean
  onCost?: (conversationId: string, cost: ConversationCost | undefined) => void
  provider?: 'claude' | 'codex'
  view: Partial<ConversationView>
  peerPending?: readonly PeerPendingView[]
  now?: number
}) {
  if (now !== undefined) vi.setSystemTime(now)
  const rig = createFakeYesChef()
  vi.spyOn(rig.api, 'cancelPeer')
  const { projects } = fakeProjects(PEER_PROJECTS)
  render(<ConversationPane isActive={isActive} {...(onCost === undefined ? {} : { onCost })} api={rig.api} projects={projects} projectId="p1" conversationId={conversationId} provider={provider} />)
  for (const turn of view.turns ?? []) {
    for (const block of turn.blocks) {
      if (block.kind === 'tool') rig.emitEvents([{ kind: 'tool-use', messageId: 'm1', index: 0, id: block.id, name: block.name, input: block.input }], conversationId)
      if (block.kind === 'peer-question') rig.emitEvents([{ kind: 'user-text', text: formatPeerInjection(block) }], conversationId)
    }
  }
  if (view.ended) rig.emitEvents([{ kind: 'session-end', isError: false, ...(view.cost?.turns === undefined ? {} : { numTurns: view.cost.turns }), ...(view.cost?.usd === undefined ? {} : { costUsd: view.cost.usd }) }], conversationId)
  rig.emitPeer({ pending: peerPending })
  return rig
}

it('等待秒數逐秒更新且不為負,提問方可回答,了結後移除介入', async () => {
  vi.useFakeTimers()
  const now = 1_000_000
  const rig = renderPane({
    conversationId: 'c1', now,
    view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name: ASK_PEER_TOOL, input: {}, status: 'running' }] }] },
    peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: now + 1_000, queued: false }],
  })
  expect(screen.getByTestId('peer-status').textContent).toContain('已等 0 秒')
  await act(async () => { vi.advanceTimersByTime(3_000) })
  expect(screen.getByTestId('peer-status').textContent).toContain('已等 2 秒')
  fireEvent.click(screen.getByRole('button', { name: '代替回答' }))
  fireEvent.change(screen.getByRole('textbox', { name: '代替回答的內容' }), { target: { value: '我幫他答' } })
  fireEvent.click(screen.getAllByRole('button', { name: '送出' })[0]!)
  expect(rig.calls).toContain('answerPeerAsUser:q1:我幫他答')
  rig.emitEvents([{ kind: 'tool-result', id: 'tu1', content: '我幫他答', isError: false }], 'c1')
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  rig.emitPeer({ pending: [] })
  expect(vi.getTimerCount()).toBe(0)
})

it('無關 pane 不起計時器,回答方才起並在了結後停止', async () => {
  vi.useFakeTimers()
  const item = { questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }
  const rig = renderPane({ conversationId: 'c3', view: { turns: [] }, peerPending: [item] })
  await act(async () => {})
  expect(vi.getTimerCount()).toBe(0)
  rig.emitPeer({ pending: [{ ...item, targetConversationId: 'c3' }] })
  expect(vi.getTimerCount()).toBe(1)
  rig.emitPeer({ pending: [] })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['claude', 'codex'] as const)('提問方標頭顯示對方 %s 與前八碼,歷史檢視不提供介入', (targetProvider) => {
  const rig = renderPane({ conversationId: 'c1', provider: targetProvider === 'codex' ? 'claude' : 'codex',
    view: { turns: [{ role: 'assistant', blocks: [{ kind: 'tool', id: 'tu1', name: ASK_PEER_TOOL, input: {}, status: 'running' }] }] },
    peerPending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider, targetLinkId: 'bbbb2222-long', text: '在嗎', createdAt: 1, queued: false }],
  })
  expect(screen.getByTestId('peer-from').textContent).toBe(`${targetProvider} · bbbb2222`)
  expect(screen.getByText(/bbbb2222/).textContent).not.toContain('-long')
  expect(screen.queryByText(/aaaa1111/)).toBeNull()
  rig.emitState({ kind: 'viewing', sessionId: 'history' }, 'c1')
  expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
})

async function flush() { await act(async () => {}) }

describe('回報花費給狀態列', () => {
  it('是前景時回報花費', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: true, onCost, view: { ended: true, cost: { turns: 2, usd: 0.5 } } })
    await flush()
    expect(onCost).toHaveBeenCalledWith('c1', { turns: 2, usd: 0.5 })
  })

  it('不是前景時不回報', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: false, onCost, view: { ended: true, cost: { turns: 2, usd: 0.5 } } })
    await flush()
    expect(onCost).not.toHaveBeenCalled()
  })

  it('成為前景而自己還沒有花費時回報 undefined,不讓上一個對話的數字留著', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: true, onCost, view: { ended: false } })
    await flush()
    expect(onCost).toHaveBeenCalledWith('c1', undefined)
  })
})

describe('assistant 的標示跟著 provider', () => {
  it('codex 對話標 Codex,claude 對話標 Claude', () => {
    // renderPane 只把 tool 與同伴提問的區塊轉成事件,用一個 tool 產生 assistant 那一輪
    // Task 1(PROVIDERS 表)把這裡改成查 PROVIDER_LABELS,codex 的行內顯示統一成 'Codex'
    // (跟 provider-badge 原本就用的大寫一致),不再是舊版另一份 ASSISTANT_LABEL 裡的小寫 'codex'。
    const view = { turns: [{ role: 'assistant' as const, blocks: [{ kind: 'tool' as const, id: 'tu1', name: 'Bash', input: {}, status: 'running' as const }] }] }
    const label = () => document.querySelector('.turn-assistant .turn-role')?.textContent
    renderPane({ conversationId: 'c1', provider: 'codex', view })
    expect(label()).toBe('Codex')
    cleanup()
    renderPane({ conversationId: 'c1', provider: 'claude', view })
    expect(label()).toBe('Claude')
  })
})

it('提示條在捲動區外，卡留在工具原位；回答後更新數量並恢復輸入', async () => {
  const fake = createFakeYesChef()
  const { projects } = fakeProjects(PEER_PROJECTS)
  const { container } = render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="claude" />)
  await flush()
  expect(screen.queryByRole('region', { name: '待批准工具' })).toBeNull()
  fake.emitEvents([{ kind: 'tool-use', messageId: 'm1', index: 0, id: 'tu1', name: 'Bash', input: {} }], 'c1')
  fake.emitAsk(ask({}))
  fake.emitAsk(ask({ requestId: 'r2', toolUseId: 'tu2', toolName: 'Read' }))
  const strip = screen.getByRole('region', { name: '待批准工具' })
  expect(strip.parentElement?.className).toBe('conversation')
  expect(strip.nextElementSibling?.className).toBe('approval-tail')
  expect(strip.closest('.conversation-list')).toBeNull()
  expect(container.querySelector('.conversation-list .approval-card')?.getAttribute('data-request-id')).toBe('r1')
  expect(container.querySelector('.approval-tail .approval-card')?.getAttribute('data-request-id')).toBe('r2')
  const input = screen.getByRole('textbox', { name: '輸入訊息' }) as HTMLTextAreaElement
  expect(input.placeholder).toBe('有 2 個工具在等你批准,先回答上面的卡片')
  expect(input.disabled).toBe(true)
  const allow = strip.querySelector('button:nth-child(2)')
  if (allow === null) throw new Error('找不到允許按鈕')
  fireEvent.click(allow)
  expect(fake.replies).toEqual([{ requestId: 'r1', decision: 'allow' }])
  expect(input.placeholder).toBe('有 1 個工具在等你批准,先回答上面的卡片')
  fireEvent.click(screen.getByRole('button', { name: '前往' }))
  const card = screen.getByTestId('approval-card')
  expect(document.activeElement).toBe(card)
  fireEvent.keyDown(card, { key: 'n' })
  expect(fake.replies).toEqual([{ requestId: 'r1', decision: 'allow' }, { requestId: 'r2', decision: 'deny' }])
  expect(screen.queryByRole('region', { name: '待批准工具' })).toBeNull()
  expect(input.disabled).toBe(false)
  expect(input.placeholder).toBe('輸入訊息，Enter 送出，Shift+Enter 換行')
})

it('背景與非目標 pane 不搶焦點，目標成為前景後才聚焦', async () => {
  const fake = createFakeYesChef()
  const { projects } = fakeProjects(PEER_PROJECTS)
  const props = { api: fake.api, projects, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const, jumpToken: 1 }
  const { rerender } = render(<ConversationPane {...props} isActive={false} jumpTarget={{ projectId: 'p1', tabId: 'c1' }} />)
  await flush()
  fake.emitAsk(ask({}))
  const card = screen.getByTestId('approval-card')
  expect(screen.queryByRole('region', { name: '待批准工具' })).toBeNull()
  expect(document.activeElement).not.toBe(card)
  rerender(<ConversationPane {...props} isActive jumpTarget={{ projectId: 'p2', tabId: 'c1' }} />)
  expect(document.activeElement).not.toBe(card)
  rerender(<ConversationPane {...props} isActive jumpTarget={{ projectId: 'p1', tabId: 'c2' }} />)
  expect(document.activeElement).not.toBe(card)
  rerender(<ConversationPane {...props} isActive jumpTarget={{ projectId: 'p1', tabId: 'c1' }} />)
  expect(document.activeElement).toBe(card)
})

it('同一跳轉 token 不因其他批准事件或首筆請求變動重跳，token 加一才再跳', async () => {
  const fake = createFakeYesChef()
  const { projects } = fakeProjects(PEER_PROJECTS)
  const props = { api: fake.api, projects, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const, isActive: true, jumpTarget: { projectId: 'p1', tabId: 'c1' } }
  const { rerender } = render(<ConversationPane {...props} jumpToken={0} />)
  await flush()
  fake.emitAsk(ask({}))
  const card = screen.getByTestId('approval-card')
  const scroll = vi.fn()
  Object.defineProperty(card, 'scrollIntoView', { configurable: true, value: scroll })
  const focus = vi.spyOn(card, 'focus')
  try {
    rerender(<ConversationPane {...props} jumpToken={1} />)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    fake.emitAsk(ask({ requestId: 'foreign', conversationId: 'c2' }))
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    rerender(<ConversationPane {...props} jumpToken={2} />)
    expect(scroll).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenCalledTimes(2)
    fake.emitAsk(ask({ requestId: 'r2', toolUseId: 'tu2' }))
    const nextCard = screen.getAllByTestId('approval-card').find((node) => node.getAttribute('data-request-id') === 'r2')
    if (nextCard === undefined) throw new Error('找不到下一張批准卡')
    const nextScroll = vi.fn()
    Object.defineProperty(nextCard, 'scrollIntoView', { configurable: true, value: nextScroll })
    const nextFocus = vi.spyOn(nextCard, 'focus')
    try {
      fireEvent.keyDown(card, { key: 'y' })
      expect(nextScroll).not.toHaveBeenCalled()
      expect(nextFocus).not.toHaveBeenCalled()
      rerender(<ConversationPane {...props} jumpToken={3} />)
      expect(nextScroll).toHaveBeenCalledTimes(1)
      expect(nextFocus).toHaveBeenCalledTimes(1)
    } finally {
      nextFocus.mockRestore()
    }
  } finally {
    focus.mockRestore()
  }
})

it('busy 只收到使用者訊息仍是思考中，assistant 文字出現才切成執行中', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const projects = fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'] })] }).projects
  const { rerender } = render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="claude" />)
  fake.emitEvents([{ kind: 'user-text', text: '新的問題' }], 'c1')
  act(() => { vi.advanceTimersByTime(3000) })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 3 秒')).toBeTruthy()
  expect(screen.queryByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 3 秒')).toBeNull()
  fake.emitEvents([{ kind: 'text-delta', messageId: 'm1', index: 0, text: '收到問題' }], 'c1')
  rerender(<ConversationPane isActive api={fake.api} projects={fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'], producingTabIds: ['c1'] })] }).projects} projectId="p1" conversationId="c1" provider="claude" />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 3 秒')).toBeTruthy()
  expect(screen.queryByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 3 秒')).toBeNull()
})

it('只有 assistant 訊息骨架時仍是思考中，原骨架新增文字才切成執行中', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const projects = fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'] })] }).projects
  const { rerender } = render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="claude" />)
  fake.emitEvents([{ kind: 'message-start', messageId: 'm1' }], 'c1')
  act(() => { vi.advanceTimersByTime(2000) })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 2 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'text-delta', messageId: 'm1', index: 0, text: '開始回答' }], 'c1')
  rerender(<ConversationPane isActive api={fake.api} projects={fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'], producingTabIds: ['c1'] })] }).projects} projectId="p1" conversationId="c1" provider="claude" />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 2 秒')).toBeTruthy()
})

it('送出後等 assistant 內容才從思考中切成執行中，下一輪重新起算', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const makeProjects = (busy: boolean, produced = false) => fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: busy ? ['c1'] : [], producingTabIds: produced ? ['c1'] : [] })] }).projects
  const props = { api: fake.api, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const, isActive: true }
  const { rerender, container } = render(<ConversationPane {...props} projects={makeProjects(false)} />)
  fake.emitEvents([{ kind: 'text-delta', messageId: 'old', index: 0, text: '上一輪' }], 'c1')
  expect(container.querySelector('.conversation-busy')).toBeNull()
  fake.emitEvents([{ kind: 'user-text', text: '送出新問題' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true)} />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 0 秒')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(3000) })
  fake.emitEvents([{ kind: 'session-start', sessionId: 's1' }], 'c1')
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 3 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'user-text', text: '新的問題' }], 'c1')
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 3 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'text-delta', messageId: 'new', index: 0, text: '新的回答' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true, true)} />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 3 秒')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(58000) })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 1 分 1 秒')).toBeTruthy()
  rerender(<ConversationPane {...props} projects={makeProjects(false)} />)
  expect(container.querySelector('.conversation-busy')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  fake.emitEvents([{ kind: 'user-text', text: '送出新問題' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true)} />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 0 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'user-text', text: '下一輪問題' }], 'c1')
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 1 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'text-delta', messageId: 'next', index: 0, text: '下一輪回答' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true, true)} />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 1 秒')).toBeTruthy()
})


it('思考超過一分鐘時秒數也換成分鐘制', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const makeProjects = (busy: boolean) => fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: busy ? ['c1'] : [] })] }).projects
  const props = { api: fake.api, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const, isActive: true }
  const { rerender } = render(<ConversationPane {...props} projects={makeProjects(false)} />)
  fake.emitEvents([{ kind: 'user-text', text: '一個很難的問題' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true)} />)
  act(() => { vi.advanceTimersByTime(75000) })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 1 分 15 秒')).toBeTruthy()
})

it('busy 先翻成 true、使用者訊息回聲還沒到時仍是思考中', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const makeProjects = (busy: boolean) => fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: busy ? ['c1'] : [] })] }).projects
  const props = { api: fake.api, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const, isActive: true }
  const { rerender } = render(<ConversationPane {...props} projects={makeProjects(false)} />)
  // 上一輪留下的 assistant 內容;Claude 路徑是 setBusy(true) 先送出,user-text 至少晚 16ms。
  fake.emitEvents([{ kind: 'text-delta', messageId: 'old', index: 0, text: '上一輪回答' }], 'c1')
  rerender(<ConversationPane {...props} projects={makeProjects(true)} />)
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 0 秒')).toBeTruthy()
  fake.emitEvents([{ kind: 'user-text', text: '新的問題' }], 'c1')
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '模型思考中 0 秒')).toBeTruthy()
})

it('切回前景重播 RESET 與完整 log，已有內容維持執行中且秒數延續', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10000)
  const fake = createFakeYesChef()
  const projects = fakeProjects({ activeId: 'p1', projects: [projectView('p1', {
    busyTabIds: ['c1'], busySince: { c1: 2000 }, producingTabIds: ['c1'],
  })] }).projects
  const props = { api: fake.api, projects, projectId: 'p1', conversationId: 'c1', provider: 'claude' as const }
  const { rerender, container, unmount } = render(<ConversationPane {...props} isActive={false} />)
  expect(vi.getTimerCount()).toBe(0)
  expect(container.querySelector('.conversation-busy')).toBeNull()
  act(() => {
    rerender(<ConversationPane {...props} isActive />)
    fake.emitEvents([{ kind: 'reset' }, { kind: 'user-text', text: '問題' },
      { kind: 'text-delta', messageId: 'answer', index: 0, text: '回答' }], 'c1')
  })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 8 秒')).toBeTruthy()
  expect(screen.queryByText(/模型思考中/)).toBeNull()
  fake.emitEvents([{ kind: 'reset' }], 'c1')
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 8 秒')).toBeTruthy()

  rerender(<ConversationPane {...props} isActive={false} />)
  act(() => { vi.advanceTimersByTime(5000) })
  act(() => {
    rerender(<ConversationPane {...props} isActive />)
    fake.emitEvents([{ kind: 'reset' }, { kind: 'user-text', text: '問題' },
      { kind: 'text-delta', messageId: 'answer', index: 0, text: '回答' }], 'c1')
  })
  expect(screen.getByText((_, element) => element?.className === 'conversation-busy' && element.textContent === '執行中 13 秒')).toBeTruthy()
  expect(screen.queryByText(/模型思考中/)).toBeNull()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('busy 狀態以 polite 播報文字，秒數不納入播報', () => {
  vi.useFakeTimers()
  const fake = createFakeYesChef()
  const projects = fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'] })] }).projects
  const { container, rerender } = render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p1" conversationId="c1" provider="claude" />)
  const status = container.querySelector('.conversation-busy')
  expect(status?.getAttribute('role')).toBe('status')
  expect(status?.getAttribute('aria-live')).toBe('polite')
  expect(status?.firstChild?.textContent).toBe('模型思考中')
  act(() => { vi.advanceTimersByTime(3000) })
  expect(status?.querySelector('[aria-hidden="true"]')?.textContent).toBe(' 3 秒')
  expect(status?.firstChild?.textContent).toBe('模型思考中')
  fake.emitEvents([{ kind: 'text-delta', messageId: 'm1', index: 0, text: '回答' }], 'c1')
  rerender(<ConversationPane isActive api={fake.api} projects={fakeProjects({ activeId: 'p1', projects: [projectView('p1', { busyTabIds: ['c1'], producingTabIds: ['c1'] })] }).projects} projectId="p1" conversationId="c1" provider="claude" />)
  expect(status?.firstChild?.textContent).toBe('執行中')
  expect(status?.querySelector('[aria-hidden="true"]')?.textContent).toBe(' 3 秒')
})

it('收合歷史保留輸入草稿，空白訊息不可送出，送出後焦點回到輸入框', async () => {
  const fake = createFakeYesChef({ projects: ONE_PROJECT })
  const { projects } = fakeProjects(ONE_PROJECT)
  render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />)
  const input = screen.getByRole('textbox', { name: '輸入訊息' }) as HTMLTextAreaElement
  const send = screen.getByRole('button', { name: '送出' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(input, { target: { value: '保留草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '歷史' }))
  expect(screen.queryByRole('navigation', { name: '歷史對話' })).toBeNull()
  expect(input.value).toBe('保留草稿')
  fireEvent.click(screen.getByRole('button', { name: '歷史' }))
  expect(screen.getByRole('navigation', { name: '歷史對話' })).not.toBeNull()
  fireEvent.click(send)
  await waitFor(() => expect(input.value).toBe(''))
  expect(document.activeElement).toBe(input)
  expect(send.disabled).toBe(true)
})

it('窄欄歷史按需開啟，開啟時內容 inert，Escape 恢復焦點', () => {
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, right: 480, top: 0, bottom: 800, width: 480, height: 800, toJSON: () => ({}) })
  try {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container } = render(<ConversationPane isActive api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />)
    const toggle = screen.getByRole('button', { name: '歷史' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true)
    const search = screen.getByRole('searchbox', { name: '搜尋歷史對話' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(toggle)
  } finally { measure.mockRestore() }
})

it('只有照片也能送出；失敗保留附件與草稿，重試成功才清除', async () => {
  const fake = createFakeYesChef({ projects: ONE_PROJECT })
  const { projects } = fakeProjects(ONE_PROJECT)
  const id = '10000000-0000-4000-8000-000000000001'
  let fail = true
  const conversationTools = vi.fn<typeof fake.api.conversationTools>(async request => {
    if (request.action === 'pick') return { kind: 'attachments', attachments: [{ id, name: 'photo.png', kind: 'image', size: 100, thumbnail: 'data:image/png;base64,aGVsbG8=' }] }
    if (request.action === 'send') return fail ? { kind: 'error', message: '模擬送出失敗' } : { kind: 'sent' }
    return { kind: 'attachments', attachments: [] }
  })
  render(<ConversationPane isActive api={{ ...fake.api, conversationTools }} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />)
  fireEvent.click(screen.getByRole('button', { name: '附加文件或照片' }))
  await screen.findByRole('img', { name: 'photo.png' })
  await waitFor(() => expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '送出' }))
  await screen.findByText('模擬送出失敗')
  expect(screen.getByRole('img', { name: 'photo.png' })).not.toBeNull()
  fail = false; fireEvent.click(screen.getByRole('button', { name: '送出' }))
  await waitFor(() => expect(screen.queryByRole('img', { name: 'photo.png' })).toBeNull())
  expect(conversationTools).toHaveBeenCalledWith({ action: 'send', conversationId: 'p-1-conv', text: '', attachments: [id] })
})
