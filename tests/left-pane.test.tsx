// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/components/Terminal.js', () => ({
  Terminal: ({ projectId, command }: { projectId: string; command?: string }) => (
    <div data-testid="term">{`${projectId}:${command ?? 'zsh'}`}</div>
  ),
}))

import { LeftPane, EMPTY_HINT, LEFT_PANE_UI_TEXT, NEW_CONVERSATION_LABEL, NEW_CODEX_CONVERSATION_LABEL, NEW_GROK_CONVERSATION_LABEL, LAST_CONVERSATION_HINT, CLOSE_BUSY_CONFIRM } from '../src/renderer/components/LeftPane.js'
import { EMPTY_PROJECTS, ONE_PROJECT, fakeProjects, projectView, terminalTab } from './helpers/fake-yeschef.js'
import type { ProjectsView } from '../src/shared/projects.js'
import { BrowserSessionsContext } from '../src/renderer/browser-context.js'

afterEach(() => { cleanup(); localStorage.clear() })

const WS = 'ws://127.0.0.1:1'

it('群組分頁固定排第一且沒有關閉鈕,快捷列不再另畫群組按鈕', () => {
  const view: ProjectsView = {
    ...ONE_PROJECT,
    activeId: 'a',
    projects: [projectView('a', { tabs: [
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: -1, lastFocusedAt: 1, threadId: 'a-th' },
      { id: 'a-group', contentType: 'group', label: '群組', customLabel: null, sortOrder: 99, lastFocusedAt: 2 },
    ] })],
  }
  render(<LeftPane projects={fakeProjects(view).projects} endpoint={WS} renderConversation={() => <div />} />)
  const tabs = screen.getAllByRole('tab')
  expect(tabs[0]?.getAttribute('data-provider')).toBe('group')
  expect(tabs[0]?.querySelector('.tab-close')).toBeNull()
  expect(screen.queryByRole('button', { name: '群組' })).toBeNull()
})

it('群組分頁掛 renderGroup 的內容,切走只是 hidden 不卸載', () => {
  const withGroup: ProjectsView = {
    activeId: 'a',
    projects: [projectView('a', {
      activeTabId: 'a-group',
      tabs: [
        { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'a-th' },
        { id: 'a-group', contentType: 'group', label: '群組', customLabel: null, sortOrder: 1, lastFocusedAt: 5 },
      ],
    })],
  }
  const { projects } = fakeProjects(withGroup)
  const renderGroup = (id: string) => <div data-testid="group">{id}</div>
  const { rerender } = render(<LeftPane projects={projects} endpoint={WS} renderConversation={() => <div />} renderGroup={renderGroup} />)
  const group = screen.getByTestId('group')
  expect(screen.getByRole('tab', { name: /群組/ }).getAttribute('data-provider')).toBe('group')
  expect(group.textContent).toBe('a')
  expect(slotOf(group).hidden).toBe(false)

  const conversationActive: ProjectsView = {
    ...withGroup,
    projects: [projectView('a', { ...withGroup.projects[0], activeTabId: 'a-conv' })],
  }
  const nextProjects = fakeProjects(conversationActive).projects
  rerender(<LeftPane projects={nextProjects} endpoint={WS} renderConversation={() => <div />} renderGroup={renderGroup} />)
  expect(screen.getByTestId('group')).toBe(group)
  expect(slotOf(group).hidden).toBe(true)
})

it('只掛載曾經成為前景的專案群組分頁', async () => {
  const groupedProject = (id: string) => projectView(id, {
    activeTabId: `${id}-group`,
    tabs: [{ id: `${id}-group`, contentType: 'group', label: '群組', customLabel: null, sortOrder: 0, lastFocusedAt: 1 }],
  })
  const view: ProjectsView = { activeId: 'a', projects: [groupedProject('a'), groupedProject('b')] }
  const renderGroup = (id: string) => <div data-testid={`group-${id}`}>{id}</div>
  const { projects } = fakeProjects(view)
  const { rerender } = render(<LeftPane projects={projects} endpoint={WS} renderConversation={() => <div />} renderGroup={renderGroup} />)
  expect(screen.getByTestId('group-a')).toBeTruthy()
  expect(screen.queryByTestId('group-b')).toBeNull()

  const switched: ProjectsView = { ...view, activeId: 'b' }
  rerender(<LeftPane projects={fakeProjects(switched).projects} endpoint={WS} renderConversation={() => <div />} renderGroup={renderGroup} />)
  await waitFor(() => expect(screen.getByTestId('group-b')).toBeTruthy())
})

/** 專案 a:對話 + codex 終端 + zsh 終端(sortOrder 故意打亂,測排序)。 */
const A_WITH_TERMS = projectView('a', {
  tabs: [
    terminalTab('a-t2', 'zsh', 2),
    { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'a-th' },
    terminalTab('a-t1', 'codex', 1, 'codex'),
  ],
  activeTabId: 'a-conv',
})

function slotOf(el: HTMLElement): HTMLElement {
  const slot = el.closest('.pane-slot')
  if (!(slot instanceof HTMLElement)) throw new Error('元素不在 .pane-slot 裡')
  return slot
}

function openLaunchMenu(): void {
  fireEvent.click(document.querySelector('.split-launch-menu summary')!)
}

describe('LeftPane 沒有專案', () => {
  it('顯示提示,不畫分頁列,對話 pane 不掛載', () => {
    const { projects } = fakeProjects(EMPTY_PROJECTS)
    render(<LeftPane projects={projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    expect(screen.getByText(EMPTY_HINT)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByTestId('conv')).toBeNull()
  })
})

describe('LeftPane 分頁列', () => {
  it('依溢位與水平捲動位置顯示左右淡出提示', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] }).projects} renderConversation={() => <div />} endpoint={WS} />)
    const rail = document.querySelector<HTMLElement>('.conversation-tabs')!
    Object.defineProperties(rail, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 400 },
    })

    fireEvent.scroll(rail)
    expect(document.querySelector('.conversation-tabs-fade--right')).toBeTruthy()
    expect(document.querySelector('.conversation-tabs-fade--left')).toBeNull()

    rail.scrollLeft = 100
    fireEvent.scroll(rail)
    expect(document.querySelector('.conversation-tabs-fade--left')).toBeTruthy()
    expect(document.querySelector('.conversation-tabs-fade--right')).toBeTruthy()

    rail.scrollLeft = 200
    fireEvent.scroll(rail)
    expect(document.querySelector('.conversation-tabs-fade--left')).toBeTruthy()
    expect(document.querySelector('.conversation-tabs-fade--right')).toBeNull()
  })

  it('分頁依 sortOrder 排列,唯一的對話分頁關閉鈕停用,customLabel 優先於 label', () => {
    const view: ProjectsView = {
      activeId: 'a',
      projects: [
        projectView('a', {
          tabs: [...A_WITH_TERMS.tabs.slice(0, 2), { ...terminalTab('a-t1', 'codex', 1, 'codex'), customLabel: '我的 codex' }],
        }),
      ],
    }
    render(<LeftPane projects={fakeProjects(view).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.querySelector('span')?.textContent)).toEqual(['Claude 對話', '我的 codex', 'zsh'])
    expect((tabs[0]?.querySelector('.tab-close') as HTMLButtonElement).disabled).toBe(true)
    expect(tabs[1]?.querySelector('.tab-close')).not.toBeNull()
  })

  it('對話分頁 active 時只顯示對話 slot;終端分頁 active 時只顯示那個終端', () => {
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />
    )
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(false)
    const terms = screen.getAllByTestId('term')
    expect(terms.map((t) => t.textContent)).toEqual(['a:zsh', 'a:codex'])
    expect(terms.every((t) => slotOf(t).hidden)).toBe(true)

    const codexActive = projectView('a', { tabs: A_WITH_TERMS.tabs, activeTabId: 'a-t1' })
    rerender(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [codexActive] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />
    )
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
    expect(slotOf(screen.getByText('a:codex')).hidden).toBe(false)
    expect(slotOf(screen.getByText('a:zsh')).hidden).toBe(true)
  })

  it('點分頁送 activateTab;點 × 送 closeTab 且不觸發 activateTab;快捷送 openTab', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] })
    render(<LeftPane projects={projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    fireEvent.click(screen.getByRole('tab', { name: /^zsh/ }))
    const terminalTab = screen.getAllByRole('tab').find((tab) => tab.querySelector('span')?.textContent === 'codex')!
    fireEvent.click(terminalTab.querySelector('.tab-close')!)
    fireEvent.click(screen.getByRole('button', { name: 'codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))
    expect(calls).toEqual(['activateTab:a-t2', 'closeTab:a-t1', 'openTab:codex:codex', 'openTab:zsh:-'])
  })

  it('endpoint 還沒好時終端 slot 顯示連線中', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={null} />)
    expect(screen.getAllByText('終端機連線中')).toHaveLength(2)
    expect(screen.queryAllByTestId('term')).toHaveLength(0)
  })
})

describe('LeftPane 切專案', () => {
  const B = projectView('b', { tabs: [...projectView('b').tabs, terminalTab('b-t1', 'zsh', 1)], activeTabId: 'b-t1' })

  it('切到別的專案後,前一個專案的終端仍掛載但隱藏;沒成為過 active 的專案不掛', () => {
    const both = [A_WITH_TERMS, B]
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: both }).projects} renderConversation={(pid, cid) => <div data-testid={`conv-${cid}`}>{`${pid}/${cid}`}</div>} endpoint={WS} />
    )
    expect(screen.getAllByTestId('term').map((t) => t.textContent)).toEqual(['a:zsh', 'a:codex'])

    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: both }).projects} renderConversation={(pid, cid) => <div data-testid={`conv-${cid}`}>{`${pid}/${cid}`}</div>} endpoint={WS} />)
    const terms = screen.getAllByTestId('term').map((t) => t.textContent)
    expect(terms).toEqual(['a:zsh', 'a:codex', 'b:zsh'])
    expect(slotOf(screen.getByText('a:codex')).hidden).toBe(true)
    expect(slotOf(screen.getByText('b:zsh')).hidden).toBe(false)
    expect(slotOf(screen.getByTestId('conv-b-conv')).hidden).toBe(true)
    expect(slotOf(screen.getByTestId('conv-a-conv')).hidden).toBe(true)
    const bConversationActive = { ...B, activeTabId: 'b-conv' }
    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: [A_WITH_TERMS, bConversationActive] }).projects} renderConversation={(pid, cid) => <div data-testid={`conv-${cid}`}>{`${pid}/${cid}`}</div>} endpoint={WS} />)
    expect(slotOf(screen.getByTestId('conv-b-conv')).hidden).toBe(false)
    expect(slotOf(screen.getByTestId('conv-a-conv')).hidden).toBe(true)
  })

  it('專案被移除後它的終端才卸載', () => {
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS, B] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />
    )
    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: [A_WITH_TERMS, B] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    expect(screen.getAllByTestId('term')).toHaveLength(3)
    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: [B] }).projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    expect(screen.getAllByTestId('term').map((t) => t.textContent)).toEqual(['b:zsh'])
  })
})

describe('LeftPane 專案不可用', () => {
  it('顯示資料夾不存在與兩顆鈕,不畫分頁列;鈕分別呼叫 relocate 與 remove', () => {
    const gone = projectView('a', { rootPath: '/Users/x/gone', available: false })
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [gone] })
    render(<LeftPane projects={projects} renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>} endpoint={WS} />)
    expect(screen.getByRole('alert').textContent).toContain('資料夾 /Users/x/gone 不存在')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新指定資料夾' }))
    fireEvent.click(screen.getByRole('button', { name: '移除專案' }))
    expect(calls).toEqual(['relocate:a', 'remove:a'])
  })
})

describe('LeftPane 對話分頁', () => {
  const twoConvs = projectView('a', {
    tabs: [
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'a-th', provider: 'claude' },
      { id: 'a-conv2', contentType: 'conversation', label: 'Claude 對話 2', customLabel: null, sortOrder: 1, lastFocusedAt: 2, threadId: 'a-th2', provider: 'claude' },
    ],
    activeTabId: 'a-conv2',
  })
  const renderConv = (pid: string, cid: string) => <div data-testid={`conv-${cid}`}>{`${pid}/${cid}`}</div>

  it('只掛載曾經前景過的對話分頁;切換後兩個都在,只有前景的不 hidden', () => {
    const view: ProjectsView = { activeId: 'a', projects: [twoConvs] }
    const { rerender } = render(<LeftPane projects={fakeProjects(view).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.getByTestId('conv-a-conv2')).toBeTruthy()
    expect(screen.queryByTestId('conv-a-conv')).toBeNull()

    const switched: ProjectsView = {
      activeId: 'a',
      projects: [{ ...twoConvs, activeTabId: 'a-conv', tabs: twoConvs.tabs.map((t) => (t.id === 'a-conv' ? { ...t, lastFocusedAt: 3 } : t)) }],
    }
    rerender(<LeftPane projects={fakeProjects(switched).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(slotOf(screen.getByTestId('conv-a-conv')).hidden).toBe(false)
    expect(slotOf(screen.getByTestId('conv-a-conv2')).hidden).toBe(true)
  })

  it('關掉的對話分頁卸載', () => {
    const view: ProjectsView = { activeId: 'a', projects: [twoConvs] }
    const { rerender } = render(<LeftPane projects={fakeProjects(view).projects} renderConversation={renderConv} endpoint={WS} />)
    const closed: ProjectsView = { activeId: 'a', projects: [{ ...twoConvs, activeTabId: 'a-conv', tabs: twoConvs.tabs.slice(0, 1) }] }
    rerender(<LeftPane projects={fakeProjects(closed).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.queryByTestId('conv-a-conv2')).toBeNull()
  })

  it('有瀏覽器的對話分頁顯示地球記號;正在被操作時標示為操作中', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: false }, { conversationId: 'a-conv2', busy: true }]}>
        <LeftPane projects={fakeProjects({ activeId: 'a', projects: [twoConvs] }).projects} renderConversation={renderConv} endpoint={WS} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.getAllByRole('img', { name: '有瀏覽器' })).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: '瀏覽器操作中' })).toHaveLength(1)
  })

  it('沒有 Provider 時沒有任何瀏覽器記號', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [twoConvs] }).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.queryByRole('img', { name: '有瀏覽器' })).toBeNull()
    expect(screen.queryByRole('img', { name: '瀏覽器操作中' })).toBeNull()
  })
})

describe('LeftPane 分頁列的對話分頁', () => {
  const two = projectView('a', {
    tabs: [
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 2, threadId: 'a-th', provider: 'claude' },
      { id: 'a-conv2', contentType: 'conversation', label: 'Claude 對話 2', customLabel: null, sortOrder: 1, lastFocusedAt: 1, threadId: 'a-th2', provider: 'claude' },
    ],
    activeTabId: 'a-conv',
  })
  const renderConv = () => <div data-testid="conv" />

  it('新增選單的「新 codex 對話」會開 codex', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: NEW_CODEX_CONVERSATION_LABEL }))
    expect(calls).toEqual(['openConversation:codex'])
  })

  it('選單保留三個 provider aria-label,選 Grok 會開 grok 對話', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    openLaunchMenu()
    expect(screen.getByRole('button', { name: NEW_CONVERSATION_LABEL })).toBeTruthy()
    expect(screen.getByRole('button', { name: NEW_CODEX_CONVERSATION_LABEL })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: NEW_GROK_CONVERSATION_LABEL }))
    expect(calls).toEqual(['openConversation:grok'])
  })

  it('選單的「新對話」呼叫 openConversation', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: NEW_CONVERSATION_LABEL }))
    expect(calls).toEqual(['openConversation:claude'])
  })

  it('主按鈕使用上次的 provider,終端機動作不改變記錄', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: NEW_GROK_CONVERSATION_LABEL }))
    expect(localStorage.getItem('yeschef.lastConversationProvider')).toBe('grok')
    expect(screen.getByRole('button', { name: '新增 Grok 對話' })).toBeTruthy()

    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))
    expect(localStorage.getItem('yeschef.lastConversationProvider')).toBe('grok')
    fireEvent.click(screen.getByRole('button', { name: '新增 Grok 對話' }))
    expect(calls).toEqual(['openConversation:grok', 'openTab:zsh:-', 'openConversation:grok'])
  })

  it('Escape 關閉選單並把焦點還給 summary', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [projectView('a')] }).projects} renderConversation={renderConv} endpoint={WS} />)
    openLaunchMenu()
    const menu = document.querySelector('.split-launch-menu') as HTMLDetailsElement
    const summary = menu.querySelector('summary') as HTMLElement
    expect(menu.open).toBe(true)

    fireEvent.keyDown(menu, { key: 'Escape' })

    expect(menu.open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })

  it('只有一個對話分頁時關閉鈕停用並提示;兩個以上可關', () => {
    const one = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    const { unmount } = render(<LeftPane projects={one.projects} renderConversation={renderConv} endpoint={WS} />)
    const disabled = screen.getAllByRole('tab')[0]?.querySelector('.tab-close') as HTMLButtonElement | null
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.title).toBe(LAST_CONVERSATION_HINT)
    unmount()

    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [two] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    const close = screen.getAllByRole('tab')[1]?.querySelector('.tab-close') as HTMLButtonElement
    expect(close.disabled).toBe(false)
    fireEvent.click(close)
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('關回合進行中的對話分頁要先確認;取消就不關', () => {
    const busy = { ...two, busyTabIds: ['a-conv2'] }
    const asked: string[] = []
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [busy] })
    const { rerender } = render(
      <LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={(m) => { asked.push(m); return false }} />
    )
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(asked).toEqual([CLOSE_BUSY_CONFIRM])
    expect(calls).toEqual([])

    rerender(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={() => true} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('不 busy 的對話分頁不問就關', () => {
    const asked: string[] = []
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [two] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={(m) => { asked.push(m); return false }} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(asked).toEqual([])
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('扣著批准的對話分頁亮記號', () => {
    const pending = { ...two, pendingTabIds: ['a-conv2'], pendingApproval: true }
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [pending] }).projects} renderConversation={renderConv} endpoint={WS} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.querySelector('.tab-pending')).toBeNull()
    expect(tabs[1]?.querySelector('.tab-pending')?.getAttribute('aria-label')).toBe('有待批准的請求')
  })
})

it('在跑記號只畫在 busy 的項目，且在待批准前並存', () => {
  const busy = projectView('a', { busyTabIds: ['a-conv'], pendingTabIds: ['a-conv'], pendingApproval: true })
  const { container, rerender } = render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [busy] }).projects} renderConversation={() => null} endpoint={null} />)
  const mark = screen.getByRole('img', { name: '執行中' })
  expect(mark.textContent).toBe('◐')
  expect(mark.title).toBe('執行中')
  expect(mark.className).toBe('tab-busy')
  expect(mark.nextElementSibling?.className).toBe('tab-pending')
  rerender(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [projectView('a')] }).projects} renderConversation={() => null} endpoint={null} />)
  expect(container.querySelector('.tab-busy')).toBeNull()
})

describe('worktree 分頁標題', () => {
  it.each([
    ['/', null, 'Claude 對話'],
    ['', '自訂標題', '自訂標題'],
    ['///', null, 'Claude 對話'],
    ['/repo/.worktrees/fix-tabs', null, 'Claude 對話 · fix-tabs'],
    ['/repo/.worktrees/中文修正/', '自訂標題', '自訂標題 · 中文修正'],
    ['C:\\repo\\.worktrees\\fix-tabs', null, 'Claude 對話 · fix-tabs'],
  ])('從 %s 的 basename 取得 slug', (worktreePath, customLabel, expected) => {
    const base = projectView('a')
    const project = { ...base, tabs: [
      ...base.tabs.map((tab) => ({ ...tab, label: 'Claude 對話', worktreePath, customLabel })),
      { ...terminalTab('term', 'zsh', 1), worktreePath },
    ] }
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [project] }).projects} renderConversation={() => null} endpoint={WS} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.querySelector('span')?.textContent)).toEqual([expected, 'zsh'])
  })
})


describe('新對話 worktree 表單', () => {
  it.each([false, undefined])('非 git 或舊 view (%s) 沿用直接建立、不畫選項', (isGitRepo) => {
    const openConversation = vi.fn()
    const { projects } = fakeProjects({ activeId: 'a', projects: [projectView('a', { isGitRepo })] })
    render(<LeftPane projects={{ ...projects, openConversation }} renderConversation={() => null} endpoint={WS} />)
    fireEvent.click(screen.getByRole('button', { name: '新增 Claude 對話' }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByPlaceholderText('這個對話要做什麼')).toBeNull()
    expect(openConversation).toHaveBeenCalledWith('claude')
  })

  it.each([['claude', NEW_CONVERSATION_LABEL], ['codex', NEW_CODEX_CONVERSATION_LABEL]])('勾選、輸入後建立 %s worktree 對話', (provider, label) => {
    const openConversation = vi.fn()
    const { projects } = fakeProjects({ activeId: 'a', projects: [projectView('a', { isGitRepo: true })] })
    render(<LeftPane projects={{ ...projects, openConversation }} renderConversation={() => null} endpoint={WS} />)
    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(openConversation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: '在新的 worktree 開' }))
    const create = screen.getByRole('button', { name: '建立' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    const form = create.closest('form')
    if (form === null) throw new Error('找不到表單')
    fireEvent.submit(form)
    expect(openConversation).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('這個對話要做什麼'), { target: { value: ' 測試一 ' } })
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    expect(openConversation).toHaveBeenCalledWith(provider, '測試一')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('未勾選不傳名稱；切專案清掉表單', () => {
    const openConversation = vi.fn()
    const a = fakeProjects({ activeId: 'a', projects: [projectView('a', { isGitRepo: true })] }).projects
    const { rerender } = render(<LeftPane projects={{ ...a, openConversation }} renderConversation={() => null} endpoint={WS} />)
    fireEvent.click(screen.getByRole('button', { name: '新增 Claude 對話' }))
    fireEvent.click(screen.getByRole('button', { name: '建立' }))
    expect(openConversation).toHaveBeenCalledWith('claude', undefined)
    openLaunchMenu()
    fireEvent.click(screen.getByRole('button', { name: NEW_CODEX_CONVERSATION_LABEL }))
    const b = fakeProjects({ activeId: 'b', projects: [projectView('b', { isGitRepo: true })] }).projects
    rerender(<LeftPane projects={b} renderConversation={() => null} endpoint={WS} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

it('分頁可用方向鍵切換，巢狀關閉鈕的按鍵不啟動分頁', () => {
  const { projects, calls } = fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] })
  render(<LeftPane projects={projects} renderConversation={() => <div />} endpoint={WS} />)
  const tabs = screen.getAllByRole('tab')
  fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
  expect(calls).toEqual(['activateTab:a-t1'])
  expect(document.activeElement).toBe(tabs[1])
  fireEvent.keyDown(tabs[1]!.querySelector('.tab-close')!, { key: 'Enter' })
  expect(calls).toEqual(['activateTab:a-t1'])
})
