// @vitest-environment jsdom
import { useContext } from 'react'
import { PreviewContext, type OpenPreviewRequest } from '../src/renderer/preview-context.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import { createFakeYesChef, ONE_PROJECT, projectView } from './helpers/fake-yeschef.js'

afterEach(cleanup)
afterEach(() => { vi.unstubAllGlobals() })

async function flush() { await act(async () => {}) }

describe('App 狀態列', () => {
  it('同伴提問隨既有推送更新,清空後狀態列仍在', async () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fake.emitPeer({ pending: [{
      questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2',
      askerLinkId: 'aaaa1111', targetProvider: 'claude', targetLinkId: 'bbbb2222',
      text: '在嗎', createdAt: 1, queued: false,
    }] })
    expect(document.querySelector('.status-bar')?.textContent).toContain('1 則同伴提問')
    fake.emitPeer({ pending: [] })
    expect(document.querySelector('.status-bar')).not.toBeNull()
    expect(document.querySelector('.status-bar')?.textContent).toBe('就緒')
  })

  it('狀態列跨專案加總進行中與待批准', async () => {
    const fake = createFakeYesChef()
    fake.emitProjects({
      activeId: 'p-1',
      projects: [
        { ...projectView('p-1'), busyTabIds: ['a'], pendingTabIds: [] },
        { ...projectView('p-2'), busyTabIds: ['b'], pendingTabIds: ['c'] },
      ],
    })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 個進行中')
    expect(text).toContain('1 個待批准')
  })

  it('點待批准會切到第一個待批准的專案與對話', async () => {
    const fake = createFakeYesChef({ projects: {
      activeId: 'p-1',
      projects: [projectView('p-1'), projectView('p-2', { pendingTabIds: ['p-2-conv'] })],
    } })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    const callsBeforeClick = fake.calls.length
    fireEvent.click(screen.getByRole('button', { name: '1 個待批准' }))
    expect(fake.calls.slice(callsBeforeClick)).toEqual(['activateProject:p-2', 'activateTab:p-2:p-2-conv'])
    fake.emitProjects({ activeId: 'p-1', projects: [projectView('p-1')] })
    expect(screen.queryByRole('button', { name: '1 個待批准' })).toBeNull()
    expect(document.querySelector('.status-bar')).not.toBeNull()
    expect(document.querySelector('.status-bar')?.textContent).toBe('就緒')
  })
  it('點進行中會切到第一個進行中的專案與對話', async () => {
    const fake = createFakeYesChef({ projects: {
      activeId: 'p-1',
      projects: [projectView('p-1'), projectView('p-2', { busyTabIds: ['p-2-conv'] })],
    } })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    const callsBeforeClick = fake.calls.length
    fireEvent.click(screen.getByRole('button', { name: '1 個進行中' }))
    expect(fake.calls.slice(callsBeforeClick)).toEqual(['activateProject:p-2', 'activateTab:p-2:p-2-conv'])
    fake.emitProjects({ activeId: 'p-1', projects: [projectView('p-1')] })
    expect(screen.queryByRole('button', { name: '1 個進行中' })).toBeNull()
    expect(document.querySelector('.status-bar')).not.toBeNull()
    expect(document.querySelector('.status-bar')?.textContent).toBe('就緒')
  })
})

it('切換前景對話顯示新花費,沒有花費時清除,背景更新不覆蓋前景', async () => {
  const tabs = ['a', 'b', 'c'].map((id, i) => ({
    id, contentType: 'conversation' as const, label: id, customLabel: null,
    sortOrder: i, lastFocusedAt: 0, threadId: 'p-1-th',
  }))
  const snapshot = (activeTabId: string) => ({
    activeId: 'p-1',
    projects: [projectView('p-1', { activeTabId, tabs: tabs.map((tab) => ({
      ...tab, lastFocusedAt: tab.id === activeTabId ? 1 : 0,
    })) })],
  })
  const fake = createFakeYesChef({ projects: snapshot('a') })
  vi.stubGlobal('yeschef', fake.api)
  render(<App />)
  await flush()
  const switchTo = async (id: string) => {
    fireEvent.click(screen.getByRole('tab', { name: `${id} ×` }))
    expect(fake.calls).toContain(`activateTab:p-1:${id}`)
    fake.emitProjects(snapshot(id))
    await flush()
  }
  const statusCost = () => document.querySelector('.status-bar .status-cost')
  fake.emitEvents([{ kind: 'session-end', isError: false, numTurns: 2, costUsd: 0.5 }], 'a')
  expect(statusCost()?.textContent).toBe('2 輪 · US$0.5000')
  await switchTo('b')
  expect(statusCost()).toBeNull()
  fake.emitEvents([{ kind: 'session-end', isError: false, numTurns: 3, costUsd: 0.75 }], 'b')
  expect(statusCost()?.textContent).toBe('3 輪 · US$0.7500')
  await switchTo('a')
  expect(statusCost()?.textContent).toBe('2 輪 · US$0.5000')
  fake.emitEvents([{ kind: 'session-end', isError: false, numTurns: 4, costUsd: 1 }], 'b')
  expect(statusCost()?.textContent).toBe('2 輪 · US$0.5000')
  await switchTo('b')
  expect(statusCost()?.textContent).toBe('4 輪 · US$1.0000')
  await switchTo('c')
  expect(statusCost()).toBeNull()
  await switchTo('a')
  await switchTo('c')
  expect(statusCost()).toBeNull()
  expect(document.querySelector('.status-bar')).not.toBeNull()
})

it('前景切到終端機分頁時不再顯示上一個對話的花費', async () => {
  const tabs = [
    { id: 'a', contentType: 'conversation' as const, label: 'a', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'p-1-th' },
    { id: 't', contentType: 'terminal' as const, label: 'zsh', customLabel: null, sortOrder: 1, lastFocusedAt: 0 },
  ]
  const snapshot = (activeTabId: string) => ({
    activeId: 'p-1',
    projects: [projectView('p-1', { activeTabId, tabs: tabs.map((tab) => ({
      ...tab, lastFocusedAt: tab.id === activeTabId ? 1 : 0,
    })) })],
  })
  const fake = createFakeYesChef({ projects: snapshot('a') })
  // 終端機在 jsdom 掛不起來;endpoint 給 undefined 讓 LeftPane 走「還沒連上」那條。
  vi.stubGlobal('yeschef', { ...fake.api, terminalEndpoint: () => Promise.resolve(undefined) })
  render(<App />)
  await flush()
  const statusCost = () => document.querySelector('.status-bar .status-cost')
  fake.emitEvents([{ kind: 'session-end', isError: false, numTurns: 2, costUsd: 0.5 }], 'a')
  expect(statusCost()?.textContent).toBe('2 輪 · US$0.5000')
  fake.emitProjects(snapshot('t'))
  await flush()
  expect(statusCost()).toBeNull()
  fake.emitProjects(snapshot('a'))
  await flush()
  expect(statusCost()?.textContent).toBe('2 輪 · US$0.5000')
})

describe('右側收起', () => {
  afterEach(() => { localStorage.clear() })

  it('按標題列的按鈕收起,文字換成展開,狀態記在 localStorage', async () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '收起右側' }))
    expect(screen.getByRole('button', { name: '展開右側' })).not.toBeNull()
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
    expect(localStorage.getItem('yeschef.panelCollapsed')).toBe('true')
    expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  })

  it('上次收起的話,開起來就是收起的', async () => {
    localStorage.setItem('yeschef.panelCollapsed', 'true')
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    expect(screen.getByRole('button', { name: '展開右側' })).not.toBeNull()
  })
})

it('經 PreviewContext 開預覽:右側收起時會展開,預覽分頁到前景', async () => {
  localStorage.setItem('yeschef.panelCollapsed', 'true')
  const fake = createFakeYesChef({ projects: ONE_PROJECT })
  vi.stubGlobal('yeschef', fake.api)
  let open: ((r: OpenPreviewRequest) => void) | undefined
  function Grab(): null { open = useContext(PreviewContext); return null }
  render(<App slot={<Grab />} />)
  await flush()
  act(() => { open?.({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', key: 't1:0' }) })
  expect(screen.getByRole('button', { name: '收起右側' })).not.toBeNull()
  expect(screen.getByRole('tab', { name: '截圖' }).getAttribute('aria-selected')).toBe('true')
  expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  localStorage.clear()
})

it('檔案預覽使用前景專案,可切回瀏覽器並關閉預覽', async () => {
  const fake = createFakeYesChef({ projects: ONE_PROJECT })
  const readPreview = vi.fn(async () => ({ kind: 'markdown' as const, text: '# 文件' }))
  vi.stubGlobal('yeschef', { ...fake.api, readPreview })
  let open: ((r: OpenPreviewRequest) => void) | undefined
  function Grab(): null { open = useContext(PreviewContext); return null }
  render(<App slot={<Grab />} />)
  await flush()
  act(() => { open?.({ kind: 'file', path: 'docs/a.md', location: { line: 1 } }) })
  await flush()
  expect(readPreview).toHaveBeenCalledWith({ projectId: ONE_PROJECT.activeId, path: 'docs/a.md' })
  expect(screen.getByRole('heading', { name: '文件' })).not.toBeNull()
  expect(screen.getByRole('heading', { name: '文件' }).classList.contains('preview-target')).toBe(true)
  act(() => { open?.({ kind: 'file', path: 'docs/a.md', location: { anchor: '文件' } }) })
  await flush()
  expect(screen.getAllByRole('tab', { name: 'a.md' })).toHaveLength(1)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '文件' }))
  fireEvent.click(screen.getByRole('tab', { name: '瀏覽器' }))
  expect(screen.getByRole('tab', { name: '瀏覽器' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: 'a.md' }))
  await flush()
  fireEvent.click(screen.getByRole('button', { name: '關閉預覽' }))
  expect(screen.queryByRole('tab', { name: 'a.md' })).toBeNull()
  expect(screen.getByRole('tab', { name: '瀏覽器' }).getAttribute('aria-selected')).toBe('true')
})

it('沒有前景專案時不開檔案預覽', async () => {
  const fake = createFakeYesChef()
  vi.stubGlobal('yeschef', fake.api)
  let open: ((r: OpenPreviewRequest) => void) | undefined
  function Grab(): null { open = useContext(PreviewContext); return null }
  render(<App slot={<Grab />} />)
  await flush()
  act(() => { open?.({ kind: 'file', path: 'a.md' }) })
  expect(screen.queryByRole('tab', { name: 'a.md' })).toBeNull()
})

it('切換專案後，已開啟文件內的連結仍讀原專案', async () => {
  const projects = [projectView('p1'), projectView('p2')]
  const fake = createFakeYesChef({ projects: { activeId: 'p1', projects } })
  const readPreview = vi.fn(async ({ path }: { path: string }) => ({
    kind: 'markdown' as const, text: path === 'docs/a.md' ? '[下一份](b.md)' : '# 下一份文件',
  }))
  vi.stubGlobal('yeschef', { ...fake.api, readPreview })
  let open: ((r: OpenPreviewRequest) => void) | undefined
  function Grab(): null { open = useContext(PreviewContext); return null }
  render(<App slot={<Grab />} />)
  await flush()
  act(() => { open?.({ kind: 'file', path: 'docs/a.md' }) })
  await screen.findByRole('link', { name: '下一份' })
  act(() => { fake.emitProjects({ activeId: 'p2', projects }) })
  fireEvent.click(screen.getByRole('link', { name: '下一份' }))
  await screen.findByRole('heading', { name: '下一份文件' })
  expect(readPreview).toHaveBeenLastCalledWith({ projectId: 'p1', path: 'docs/b.md' })
})

it.each(['pointerUp', 'pointerCancel'] as const)('拖曳藏瀏覽器,%s 恢復矩形', async (end) => {
  Element.prototype.setPointerCapture ??= () => undefined
  const fake = createFakeYesChef()
  vi.stubGlobal('yeschef', fake.api)
  const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 600, y: 30, width: 600, height: 800, left: 600, top: 30, right: 1200, bottom: 830, toJSON: () => ({}),
  })
  render(<App />)
  await flush()
  const handle = screen.getByRole('separator', { name: '調整主分頁區寬度' })
  fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
  expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  fireEvent.pointerMove(handle, { clientX: 480, pointerId: 1 })
  fireEvent(window, new Event('resize'))
  expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  fireEvent[end](handle, { pointerId: 1 })
  expect(fake.calls.at(-1)).toBe('setBrowserBounds:{"x":600,"y":30,"width":600,"height":800}')
  fireEvent.click(screen.getByRole('button', { name: '收起右側' }))
  expect(screen.queryByRole('separator', { name: '調整主分頁區寬度' })).toBeNull()
  rectSpy.mockRestore()
  localStorage.clear()
  document.documentElement.style.removeProperty('--panel-width')
})

it('按下當下、重繪之前已送出隱藏通知,重繪不重送', async () => {
  Element.prototype.setPointerCapture ??= () => undefined
  const fake = createFakeYesChef()
  vi.stubGlobal('yeschef', fake.api)
  render(<App />)
  await flush()
  const handle = screen.getByRole('separator')
  const before = fake.calls.filter((call) => call === 'setBrowserBounds:null').length
  // 同一個 act 內使用原生事件,斷言時 React 尚未提交批次狀態更新。
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    expect(fake.calls.filter((call) => call === 'setBrowserBounds:null')).toHaveLength(before + 1)
    window.dispatchEvent(new Event('resize'))
    expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  })
  expect(fake.calls.filter((call) => call === 'setBrowserBounds:null')).toHaveLength(before + 1)
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(fake.calls.at(-1)).not.toBe('setBrowserBounds:null')
  localStorage.clear()
  document.documentElement.style.removeProperty('--panel-width')
})

it('狀態列跨專案跳轉等待掛載與批准快照，重複點擊仍捲動聚焦第一張卡', async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  try {
    const projects = [projectView('p-1'), projectView('p-2', { pendingTabIds: ['p-2-conv'] })]
    const fake = createFakeYesChef({ projects: { activeId: 'p-1', projects } })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    const request = { requestId: 'jump-r1', projectId: 'p-2', conversationId: 'p-2-conv', toolUseId: 'jump-tu1', toolName: 'Bash', input: {} }
    const requests = [request, { ...request, requestId: 'jump-r2', toolUseId: 'jump-tu2', toolName: 'Read' }]
    vi.spyOn(fake.api, 'getApprovals').mockResolvedValue(requests)
    for (const pending of requests) fake.emitAsk(pending)
    fireEvent.click(screen.getByRole('button', { name: '1 個待批准' }))
    expect(scroll).not.toHaveBeenCalled()
    fake.emitProjects({ activeId: 'p-2', projects })
    await flush()
    const slot = document.querySelector<HTMLElement>('.pane-slot-conversation:not([hidden])')
    if (slot === null) throw new Error('找不到前景對話')
    const first = slot.querySelector('[data-request-id="jump-r1"]')
    expect(first).not.toBeNull()
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(scroll.mock.contexts.at(-1)).toBe(first)
    expect(document.activeElement).toBe(first)
    const jump = screen.getByRole('button', { name: '1 個待批准' })
    jump.focus()
    const before = scroll.mock.calls.length
    fireEvent.click(jump)
    expect(scroll).toHaveBeenCalledTimes(before + 1)
    expect(document.activeElement).toBe(first)
  } finally {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original)
  }
})

it('兩專案各兩個 busy 分頁時跳到第一專案的第一個', async () => {
  const fake = createFakeYesChef({ projects: {
    activeId: 'p-2',
    projects: ['p-1', 'p-2'].map((id) => projectView(id, {
      busyTabIds: [id + '-first', id + '-second'],
      tabs: ['first', 'second'].map((suffix, sortOrder) => ({
        id: id + '-' + suffix, contentType: 'conversation' as const,
        label: suffix, customLabel: null, sortOrder, lastFocusedAt: 0,
      })),
    })),
  } })
  vi.stubGlobal('yeschef', fake.api)
  render(<App />)
  await flush()
  const before = fake.calls.length
  fireEvent.click(screen.getByRole('button', { name: '4 個進行中' }))
  expect(fake.calls.slice(before)).toEqual(['activateProject:p-1', 'activateTab:p-1:p-1-first'])
})

it('opening Skills management hides the native browser before displaying the dialog', async () => {
  const original = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  try {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    await flush()
    expect(screen.getByRole('dialog', { name: 'Skills' })).not.toBeNull()
    expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
    fireEvent.click(screen.getByRole('button', { name: '關閉 Skills 管理' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally { HTMLDialogElement.prototype.showModal = original }
})

it('窄視窗切換對話與預覽，不改桌面收合偏好', async () => {
  const width = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
  localStorage.setItem('yeschef.panelCollapsed', 'false')
  try {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    expect(document.querySelector('.main-column')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '開啟預覽' }))
    expect(document.querySelector('.main-column')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '返回對話' }))
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
    expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
    expect(localStorage.getItem('yeschef.panelCollapsed')).toBe('false')
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); localStorage.clear() }
})

it('active 專案消失時測試機對話框跟著關閉,不再卡住原生瀏覽器的擺放矩形(I1)', async () => {
  const original = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  try {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '測試機' }))
    await flush()
    expect(screen.getByRole('dialog', { name: '測試機' })).not.toBeNull()
    const before = fake.calls.length
    fake.emitProjects({ activeId: null, projects: [] })
    await flush()
    expect(screen.queryByRole('dialog', { name: '測試機' })).toBeNull()
    // dragging 回到 false 之後,PanelGroup 又會回報一次矩形(不再是 null)。
    expect(fake.calls.slice(before).some((call) => call.startsWith('setBrowserBounds:') && call !== 'setBrowserBounds:null')).toBe(true)
  } finally { HTMLDialogElement.prototype.showModal = original }
})

it('頂欄的錯誤收集按鈕會開啟資料庫設定對話框', async () => {
  const original = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  try {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '錯誤收集' }))
    await flush()
    expect(screen.getByRole('dialog', { name: '錯誤收集資料庫' })).not.toBeNull()
  } finally { HTMLDialogElement.prototype.showModal = original }
})

it('窄版在預覽中點待批准會返回對話', async () => {
  const width = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
  try {
    const base = ONE_PROJECT.projects[0]!
    const fake = createFakeYesChef({ projects: { ...ONE_PROJECT, projects: [{ ...base, pendingApproval: true, pendingTabIds: [base.activeTabId!] }] } })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '開啟預覽' }))
    expect(document.querySelector('.main-column')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '1 個待批准' }))
    expect(document.querySelector('.main-column')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); localStorage.clear() }
})
