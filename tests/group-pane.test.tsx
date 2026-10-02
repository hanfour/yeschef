// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ALL_THREADS, GROUP_EMPTY_HINT, GroupPane } from '../src/renderer/components/GroupPane.js'
import type { ErrorIntakeResponse } from '../src/shared/error-intake.js'
import { GENERAL_THREAD_ID, GROUP_ALL_THREADS, type GroupMessage, type GroupResponse, type GroupThread } from '../src/shared/group.js'
import { createFakeYesChef } from './helpers/fake-yeschef.js'
import { notifyErrorIntakeChanged } from '../src/renderer/error-intake-events.js'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })

const NOW = 1_700_000_000_000

const general: GroupThread = { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, holdsWorkspace: false, participants: [] }
const task: GroupThread = {
  id: 't1', title: '把整份報表補完', status: 'running', createdAt: 10, holdsWorkspace: true,
  participants: [
    { label: '主廚', conversationId: 'chef-conv', provider: 'claude', role: 'chef', unitTitle: '規劃與執行' },
    { label: 'codex-1', conversationId: 'codex-conv', provider: 'codex', role: 'worker', unitTitle: '實作', sessionId: 'codex-thread' },
  ],
}

function projectView(tabIds: readonly string[]) {
  const tabs = tabIds.map((id, index) => ({
    id, contentType: 'conversation' as const, label: id, customLabel: null,
    sortOrder: index, lastFocusedAt: index, threadId: `thread-${id}`, provider: id === 'chef-conv' ? 'claude' as const : 'codex' as const,
  }))
  return {
    activeId: 'p1',
    projects: [{
      id: 'p1', name: 'alpha', rootPath: '/p1', available: true, pendingApproval: false,
      pendingTabIds: [], busyTabIds: [], producingTabIds: [], busySince: {},
      tabs, activeTabId: tabs.at(-1)?.id ?? '', threads: [],
    }],
  }
}

const message = (over: Partial<GroupMessage>): GroupMessage => ({
  id: 'm1', projectId: 'p1', threadId: 't1', at: NOW - 60_000,
  from: { kind: 'user' }, kind: 'text', text: '先補測試', mentions: [], ...over,
})

const MESSAGES: readonly GroupMessage[] = [
  message({ id: 'm1', threadId: GENERAL_THREAD_ID, text: '還沒分派的一句' }),
  message({ id: 'm2', text: '先補測試' }),
  message({ id: 'm3', kind: 'joined', text: 'codex-1 加入,負責「實作」,用 gpt-5', from: { kind: 'agent', conversationId: 'codex-conv', label: 'codex-1', provider: 'codex', role: 'worker' } }),
]

function mount(over: { messages?: readonly GroupMessage[]; threads?: readonly GroupThread[]; onSend?: (payload: unknown) => GroupResponse; projectTabs?: readonly string[]; onOpenChef?: (taskId: string) => void; errorPull?: boolean | (() => boolean) } = {}) {
  const fake = createFakeYesChef()
  const calls: unknown[] = []
  const errorCalls: unknown[] = []
  vi.spyOn(fake.api, 'manageGroup').mockImplementation(async (payload) => {
    calls.push(payload)
    if (payload.action === 'get') {
      return { kind: 'state', messages: [...(over.messages ?? MESSAGES)], threads: [...(over.threads ?? [general, task])] }
    }
    return over.onSend?.(payload) ?? (payload.action === 'openParticipant' ? { kind: 'opened' } : { kind: 'sent', threadId: 't1' })
  })
  vi.spyOn(fake.api, 'manageErrorIntake').mockImplementation(async (payload) => {
    const request = payload as unknown as { readonly action: string; readonly groupIds?: readonly string[] }
    errorCalls.push(payload)
    const errorPullEnabled = typeof over.errorPull === 'function' ? over.errorPull() : over.errorPull === true
    if (request.action === 'project' && errorPullEnabled) return {
      kind: 'project', projectId: 'p1', folderName: 'alpha', defaultProjectCode: 'alpha', enabled: true,
      projectCode: 'alpha', projectCodeLocked: true, databaseReady: true,
    } as unknown as ErrorIntakeResponse
    if (request.action === 'pull-list') return {
      kind: 'pull-list', environments: ['production'], selectedEnvironment: 'production',
      newGroups: [{ id: '01J8T3W9T1H7M4X6K2V5P0QABC', environment: 'production', errorType: 'TypeError', message: '<img src=x onerror=alert(1)>', count: 5, lastSeenAt: new Date(NOW - 60_000).toISOString(), route: '/login', regressedAt: new Date(NOW - 120_000).toISOString() }],
      inProgressGroups: [{ id: '01J8T3W9T1H7M4X6K2V5P0QABD', environment: 'production', errorType: 'RangeError', message: '處理中錯誤', count: 2, lastSeenAt: new Date(NOW - 300_000).toISOString(), route: '/orders', regressedAt: null, statusNote: 'task-2：等待 PR' }],
    } as unknown as ErrorIntakeResponse
    if (request.action === 'start-fix') return { kind: 'fix-started', taskId: 'task-new' } as unknown as ErrorIntakeResponse
    if (request.action === 'set-group-status') return { kind: 'group-status-updated' } as unknown as ErrorIntakeResponse
    return { kind: 'settings', settings: { host: '', port: 3306, database: '', tls: true, adminUsername: '', hasAdminPassword: false, hasAppPassword: false, schemaVersion: null, packageSource: '@yeschef/error-intake' } }
  })
  const projectCalls: string[] = []
  const projects = {
    view: projectView(over.projectTabs ?? ['chef-conv', 'codex-conv']),
    activate: (id: string) => { projectCalls.push(`activate:${id}`) },
    activateTab: (tabId: string, projectId?: string) => { projectCalls.push(`activateTab:${tabId}:${projectId ?? '-'}`) },
  }
  const utils = render(<GroupPane api={fake.api} projects={projects} projectId="p1" now={() => NOW} {...(over.onOpenChef === undefined ? {} : { onOpenChef: over.onOpenChef })} />)
  return { ...utils, fake, calls, errorCalls, projectCalls }
}

describe('GroupPane 的三段版面', () => {
  it('上中下三塊都在', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelector('.group-threads')).not.toBeNull())
    expect(r.container.querySelector('.group-stream')).not.toBeNull()
    expect(r.container.querySelector('.group-composer')).not.toBeNull()
  })

  it('thread 膠囊有全部、未分派與每個任務,任務帶狀態與人數', async () => {
    const r = mount()
    const strip = await waitFor(() => r.container.querySelector('.group-threads')!)
    const labels = [...strip.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels[0]).toBe('全部')
    expect(labels[1]).toBe('未分派')
    expect(labels[2]).toContain('把整份報表補完')
    expect(labels[2]).toContain('2 人')
  })

  it('預設顯示全部,點膠囊就篩選', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    expect(screen.getByText('還沒分派的一句')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    expect(screen.queryByText('還沒分派的一句')).toBeNull()
    expect(screen.getByText('先補測試')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('還沒分派的一句')).toBeTruthy()
  })

  it('里程碑與一般發言用不同的 class', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelectorAll('.group-message')).toHaveLength(3))
    const milestone = r.container.querySelector('.group-message.is-milestone')
    expect(milestone?.textContent).toContain('codex-1 加入')
    expect(r.container.querySelectorAll('.group-message.is-milestone')).toHaveLength(1)
  })

  it('帶 conversationId 的訊息右側有跳分頁按鈕', async () => {
    const r = mount()
    const milestone = await waitFor(() => {
      const row = r.container.querySelector('.group-message.is-milestone')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })
    fireEvent.click(within(milestone).getByRole('button', { name: '跳到 codex-1 的分頁' }))
    expect(r.projectCalls).toEqual(['activate:p1', 'activateTab:codex-conv:p1'])
  })

  it('worker 分頁已關閉時只送一個群組 IPC 動作', async () => {
    const r = mount({ projectTabs: ['chef-conv'] })
    const milestone = await waitFor(() => {
      const row = r.container.querySelector('.group-message.is-milestone')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })

    fireEvent.click(within(milestone).getByRole('button', { name: '跳到 codex-1 的分頁' }))

    expect(r.projectCalls).toEqual([])
    expect(r.calls.at(-1)).toEqual({
      action: 'openParticipant', projectId: 'p1', threadId: 't1', conversationId: 'codex-conv',
    })
    expect(r.fake.calls.filter(call => call.startsWith('openConversation:') || call.startsWith('openHistory:'))).toEqual([])
  })

  it('worker 分頁已關且沒有 sessionId 時顯示歷史側欄提示', async () => {
    const { sessionId: _sessionId, ...codex } = task.participants[1]!
    const noSession = { ...task, participants: [task.participants[0]!, codex] }
    const r = mount({
      projectTabs: ['chef-conv'],
      threads: [general, noSession],
      onSend: () => ({ kind: 'error', message: '這段對話的分頁已關閉，可從歷史側欄開啟' }),
    })
    const milestone = await waitFor(() => {
      const row = r.container.querySelector('.group-message.is-milestone')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })

    fireEvent.click(within(milestone).getByRole('button', { name: '跳到 codex-1 的分頁' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('這段對話的分頁已關閉，可從歷史側欄開啟'))
    expect(r.fake.calls).toEqual([])
  })

  it('人的訊息沒有跳分頁按鈕', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelectorAll('.group-message')).toHaveLength(3))
    const own = [...r.container.querySelectorAll('.group-message')].find((el) => el.textContent?.includes('先補測試'))!
    expect(within(own as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('完全沒有訊息時顯示提示', async () => {
    const r = mount({ messages: [] })
    await waitFor(() => expect(screen.getByText(GROUP_EMPTY_HINT)).toBeTruthy())
  })
})

describe('GroupPane 的 composer', () => {
  it('Enter 送出,送的是目前選中的 thread', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '再補一點' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toEqual({ action: 'send', projectId: 'p1', threadId: 't1', text: '再補一點' }))
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('選全部時只把 sentinel 交給主行程決定目標', async () => {
    const older: GroupThread = { ...task, id: 't0', title: '舊目標', createdAt: 5 }
    const r = mount({ threads: [general, older, task] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '順便問一句' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toMatchObject({ threadId: GROUP_ALL_THREADS }))
  })

  it('沒有任何進行中的目標時,選全部仍只送 sentinel', async () => {
    const done: GroupThread = { ...task, status: 'completed' }
    const r = mount({ threads: [general, done] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '開個新目標' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toMatchObject({ threadId: GROUP_ALL_THREADS }))
  })

  it('Shift+Enter 不送出', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const before = r.calls.length
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '換行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(r.calls).toHaveLength(before)
  })

  it('空白不送出,送出失敗時顯示錯誤且留住文字', async () => {
    const r = mount({ onSend: () => ({ kind: 'error', message: '找不到這個專案' }) })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    const before = r.calls.length
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(r.calls).toHaveLength(before)
    fireEvent.change(input, { target: { value: '會失敗' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('找不到這個專案'))
    expect((input as HTMLTextAreaElement).value).toBe('會失敗')
  })

  it('打 @ 會列出目前 thread 的參與者,點一個就補進輸入框', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@co' } })
    const list = await waitFor(() => r.container.querySelector('.group-mentions')!)
    const options = [...list.querySelectorAll('button')].map((b) => b.textContent)
    expect(options).toEqual(['codex-1'])
    fireEvent.click(within(list as HTMLElement).getByRole('button', { name: 'codex-1' }))
    expect((input as HTMLTextAreaElement).value).toBe('@codex-1 ')
    expect(r.container.querySelector('.group-mentions')).toBeNull()
  })

  it('@ 建議清單排除最後里程碑為 left 的參與者', async () => {
    const left = message({
      id: 'm4', kind: 'left', text: 'codex-1 離開',
      from: { kind: 'agent', conversationId: 'codex-conv', label: 'codex-1', provider: 'codex', role: 'worker' },
    })
    const r = mount({ messages: [...MESSAGES, left] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@co' } })
    expect(r.container.querySelector('.group-mentions')).toBeNull()
  })

  it('全部檢視顯示參與者提示,送出仍交由主行程選目標', async () => {
    const latest: GroupThread = {
      ...task,
      id: 't2', title: '較新目標', status: 'queued', createdAt: 15,
      participants: [task.participants[0]!, { label: 'grok-1', conversationId: 'grok-conv', provider: 'grok', role: 'worker', unitTitle: '補充' }],
    }
    const completed: GroupThread = {
      ...task,
      id: 't0', title: '已完成目標', status: 'completed', createdAt: 30,
      participants: [{ label: 'claude-1', conversationId: 'claude-done', provider: 'claude', role: 'worker', unitTitle: '舊工作' }],
    }
    const r = mount({ threads: [general, task, latest, completed] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@' } })
    await waitFor(() => expect(r.container.querySelector('.group-mentions')).not.toBeNull())
    const list = r.container.querySelector('.group-mentions')!
    expect([...list.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['主廚', 'grok-1'])

    r.unmount()
    const noRunning = mount({ threads: [general, { ...task, status: 'completed' }] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const completedInput = screen.getByLabelText('對群組說話')
    fireEvent.change(completedInput, { target: { value: '@' } })
    expect(noRunning.container.querySelector('.group-mentions')).toBeNull()
    fireEvent.change(completedInput, { target: { value: '新目標' } })
    fireEvent.keyDown(completedInput, { key: 'Enter' })
    await waitFor(() => expect(noRunning.calls.at(-1)).toMatchObject({ threadId: GROUP_ALL_THREADS }))
  })

  it('全部的 @ 建議改以仍佔用工作目錄的最新 blocked 任務為目標', async () => {
    const blocked: GroupThread = {
      ...task, id: 'blocked-held', title: '核對後接續', status: 'blocked', createdAt: 30,
      holdsWorkspace: true,
    }
    const r = mount({ messages: [], threads: [general, blocked] })
    await waitFor(() => expect(r.container.querySelector('.group-composer')).not.toBeNull())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@' } })
    const list = await waitFor(() => r.container.querySelector('.group-mentions')!)
    expect([...list.querySelectorAll('button')].map(button => button.textContent)).toEqual(['主廚', 'codex-1'])
  })

  it('@ 後面沒有比對得上的就不顯示清單', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@zzz' } })
    expect(r.container.querySelector('.group-mentions')).toBeNull()
  })
})

describe('GroupPane 的錯誤拉取', () => {
  it('只有錯誤收集已啟用時顯示「拉錯誤」按鈕', async () => {
    const disabled = mount()
    await waitFor(() => expect(disabled.container.querySelector('.group-composer')).not.toBeNull())
    expect(screen.queryByRole('button', { name: '拉錯誤' })).toBeNull()
    disabled.unmount()
    const enabled = mount({ errorPull: true })
    expect(await screen.findByRole('button', { name: '拉錯誤' })).toBeTruthy()
  })

  // 實機驗收：在錯誤收集對話框啟用後，群組分頁沒有重讀狀態，要切換專案才看得到「拉錯誤」。
  it('同一專案啟用錯誤收集後，不必切換專案就出現「拉錯誤」', async () => {
    let enabledNow = false
    const r = mount({ errorPull: () => enabledNow })
    await waitFor(() => expect(r.container.querySelector('.group-composer')).not.toBeNull())
    expect(screen.queryByRole('button', { name: '拉錯誤' })).toBeNull()
    enabledNow = true
    notifyErrorIntakeChanged('p1')
    expect(await screen.findByRole('button', { name: '拉錯誤' })).toBeTruthy()
  })

  it('別的專案啟用時不重讀這個專案', async () => {
    const r = mount({ errorPull: false })
    await waitFor(() => expect(r.container.querySelector('.group-composer')).not.toBeNull())
    const before = r.errorCalls.filter((call) => (call as { action: string }).action === 'project').length
    notifyErrorIntakeChanged('other')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.errorCalls.filter((call) => (call as { action: string }).action === 'project').length).toBe(before)
  })

  // 實機驗收：第一次打開時不帶環境查詢，主行程回報選定環境後又觸發第二次載入，剛勾的錯誤被清空。
  it('第一次打開只載入一次清單，勾選後不會被清空', async () => {
    localStorage.removeItem('error-pull-environment:p1')
    const r = mount({ errorPull: true })
    fireEvent.click(await screen.findByRole('button', { name: '拉錯誤' }))
    const checkbox = await screen.findByRole('checkbox', { name: '選取錯誤群 01J8T3W9T1H7M4X6K2V5P0QABC' })
    await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(checkbox)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((screen.getByRole('checkbox', { name: '選取錯誤群 01J8T3W9T1H7M4X6K2V5P0QABC' }) as HTMLInputElement).checked).toBe(true)
    expect(r.errorCalls.filter((call) => (call as { action: string }).action === 'pull-list')).toHaveLength(1)
  })

  it('勾選錯誤後交給主廚，成功時關閉對話框並顯示任務已開始', async () => {
    localStorage.setItem('error-pull-environment:p1', 'production')
    const r = mount({ errorPull: true })
    fireEvent.click(await screen.findByRole('button', { name: '拉錯誤' }))
    const dialog = await screen.findByRole('dialog', { name: '拉錯誤' })
    expect(await within(dialog).findByText('再次出現')).toBeTruthy()
    expect(within(dialog).getByLabelText('錯誤環境')).toHaveProperty('value', 'production')
    expect(r.errorCalls).toContainEqual({ action: 'pull-list', projectId: 'p1', environment: 'production' })
    const content = within(dialog).getByText('<img src=x onerror=alert(1)>')
    expect(content.tagName).toBe('SPAN')
    expect(content.querySelector('img')).toBeNull()
    const submit = within(dialog).getByRole('button', { name: '交給主廚' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '選取錯誤群 01J8T3W9T1H7M4X6K2V5P0QABC' }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '拉錯誤' })).toBeNull())
    expect(screen.getByRole('status').textContent).toContain('任務已開始')
    expect(r.errorCalls).toContainEqual({ action: 'start-fix', projectId: 'p1', groupIds: ['01J8T3W9T1H7M4X6K2V5P0QABC'] })
  })

  it.each(['new', 'resolved', 'ignored'] as const)('進行中的錯誤可改為 %s', async (status) => {
    const r = mount({ errorPull: true })
    fireEvent.click(await screen.findByRole('button', { name: '拉錯誤' }))
    const dialog = await screen.findByRole('dialog', { name: '拉錯誤' })
    expect(within(dialog).getByText('task-2：等待 PR')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('錯誤群 01J8T3W9T1H7M4X6K2V5P0QABD 狀態'), { target: { value: status } })
    await waitFor(() => expect(r.errorCalls).toContainEqual({
      action: 'set-group-status', projectId: 'p1', groupId: '01J8T3W9T1H7M4X6K2V5P0QABD', status,
    }))
  })

  it('localStorage 不可用時仍可載入錯誤清單', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled') })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled') })
    const r = mount({ errorPull: true })
    fireEvent.click(await screen.findByRole('button', { name: '拉錯誤' }))
    const dialog = await screen.findByRole('dialog', { name: '拉錯誤' })
    expect(await within(dialog).findByText('再次出現')).toBeTruthy()
    expect(read).toHaveBeenCalled()
    expect(write).toHaveBeenCalled()
    expect(r.errorCalls).toContainEqual({ action: 'pull-list', projectId: 'p1' })
  })
})

describe('卡住且需要核對的任務', () => {
  const stuck: GroupThread = { ...task, status: 'blocked', holdsWorkspace: true }

  it('全部檢視的目標任務需要核對時，輸入框上方出現「確認後接續」，按下去打開主廚控制台並選好任務', async () => {
    const opened: string[] = []
    mount({ threads: [general, stuck], onOpenChef: (taskId) => { opened.push(taskId) } })
    const button = await screen.findByRole('button', { name: '確認後接續' })
    expect(screen.getByRole('status').textContent).toContain('把整份報表補完')
    fireEvent.click(button)
    expect(opened).toEqual(['t1'])
  })

  it('執行中、或卡住但不需要核對的任務不顯示', async () => {
    for (const thread of [task, { ...task, status: 'blocked' as const, holdsWorkspace: false }]) {
      const r = mount({ threads: [general, thread], onOpenChef: () => {} })
      await waitFor(() => expect(r.container.querySelector('.group-threads')).not.toBeNull())
      expect(screen.queryByRole('button', { name: '確認後接續' })).toBeNull()
      cleanup()
    }
  })

  it('選了別的 thread 時跟著選的那個判斷', async () => {
    mount({ threads: [general, stuck], onOpenChef: () => {} })
    await screen.findByRole('button', { name: '確認後接續' })
    fireEvent.click(screen.getByRole('button', { name: /未分派/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '確認後接續' })).toBeNull())
  })
})
