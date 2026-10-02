import { describe, it, expect, vi } from 'vitest'
import { ipcRenderer } from 'electron'
import type { YesChefApi } from '../src/shared/ipc.js'

/**
 * preload 的鐵律測試（見 `src/preload/bridge.ts` 檔頭）：`ipcRenderer.on()` 與
 * `removeListener()` 為了鏈式呼叫都 `return this`，簡潔箭頭會把 `ipcRenderer`
 * 本體當成回傳值交給 contextBridge，renderer 接住 `onEvents(cb)` 的回傳值就拿到
 * 了完整的 ipcRenderer，context isolation 等於沒有。
 *
 * 替身刻意讓 `on`／`removeListener`／`send`／`invoke` 都回 `ipcRenderer` 自己，
 * 也就是把真品最危險的那個特性複製過來：少一對大括號，這裡就會紅。
 */
const exposed: { key: string; value: unknown }[] = []
const sent: { channel: string; payload: unknown }[] = []
const invoked: { channel: string; payload: unknown }[] = []
/** 每個 invoke channel 要回什麼;測試自己塞。 */
const replies = new Map<string, unknown>()

vi.mock('electron', () => {
  const ipcRenderer: Record<string, unknown> = {}
  Object.assign(ipcRenderer, {
    on: vi.fn(() => ipcRenderer),
    removeListener: vi.fn(() => ipcRenderer),
    send: vi.fn((channel: string, payload: unknown) => {
      sent.push({ channel, payload })
      return ipcRenderer
    }),
    invoke: (channel: string, payload: unknown) => {
      invoked.push({ channel, payload })
      return replies.has(channel) ? Promise.resolve(replies.get(channel)) : ipcRenderer
    },
  })
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed.push({ key, value })
      },
    },
    ipcRenderer,
  }
  return { ...electron, default: electron }
})

async function loadBridge(): Promise<YesChefApi> {
  await import('../src/preload/bridge.js')
  const entry = exposed[0]
  if (entry === undefined) throw new Error('preload 沒有呼叫 exposeInMainWorld')
  return entry.value as YesChefApi
}

const VIEW = {
  activeId: 'p-1',
  projects: [
    {
      id: 'p-1',
      name: 'demo',
      rootPath: '/Users/x/demo',
      available: true,
      pendingApproval: false,
      pendingTabIds: [],
      busyTabIds: [],
      busySince: {},
      producingTabIds: [],
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'th-1' }],
      threads: [{ id: 'th-1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    },
  ],
}

describe('preload 不外洩 ipcRenderer', () => {
  it('掛在 window.yeschef 底下，且訂閱的回傳值不是 ipcRenderer', async () => {
    const api = await loadBridge()

    expect(exposed).toHaveLength(1)
    expect(exposed[0]?.key).toBe('yeschef')

    for (const ret of [api.onEvents(() => undefined), api.onProjects(() => undefined)]) {
      expect(typeof ret).toBe('function')
      expect('send' in (ret as object)).toBe(false)
      expect('invoke' in (ret as object)).toBe(false)
      expect('on' in (ret as object)).toBe(false)
    }
  })

  it('所有 send 類成員回 undefined 而不是 ipcRenderer，且 payload 形狀正確', async () => {
    const api = await loadBridge()
    sent.length = 0

    expect(api.setBrowserBounds({ x: 1, y: 2, width: 3, height: 4 })).toBeUndefined()
    expect(api.setBrowserBounds(null)).toBeUndefined()
    expect(sent).toEqual([
      { channel: 'layout:browser-bounds', payload: { rect: { x: 1, y: 2, width: 3, height: 4 } } },
      { channel: 'layout:browser-bounds', payload: { rect: null } },
    ])

    expect(api.sendInput('x')).toBeUndefined()
    expect(api.replyApproval({ requestId: 'r-1', decision: 'allow' })).toBeUndefined()
    expect(api.startNew()).toBeUndefined()
    expect(api.openHistory('s-1')).toBeUndefined()
    expect(api.handoffDone('toolu_1')).toBeUndefined()
    expect(api.removeProject('p-1')).toBeUndefined()
    expect(api.activateProject('p-2')).toBeUndefined()
    expect(api.openTab({ projectId: 'p-1', label: 'codex', command: 'codex' })).toBeUndefined()
    expect(api.openTab({ projectId: 'p-1', label: 'zsh' })).toBeUndefined()
    expect(api.closeTab({ projectId: 'p-1', tabId: 't-1' })).toBeUndefined()
    expect(api.activateTab({ projectId: 'p-1', tabId: 't-2' })).toBeUndefined()

    expect(sent.slice(-6)).toEqual([
      { channel: 'projects:remove', payload: { id: 'p-1' } },
      { channel: 'projects:activate', payload: { id: 'p-2' } },
      { channel: 'tabs:open', payload: { projectId: 'p-1', label: 'codex', command: 'codex' } },
      { channel: 'tabs:open', payload: { projectId: 'p-1', label: 'zsh' } },
      { channel: 'tabs:close', payload: { projectId: 'p-1', tabId: 't-1' } },
      { channel: 'tabs:activate', payload: { projectId: 'p-1', tabId: 't-2' } },
    ])
  })

  it('invoke 類成員的回傳過 parser：形狀對就回值，不對就拋錯', async () => {
    const api = await loadBridge()
    invoked.length = 0

    replies.set('preview:read', { kind: 'markdown', text: '# 標題' })
    replies.set('projects:get', VIEW)
    replies.set('projects:add', { kind: 'cancelled' })
    replies.set('projects:relocate', { kind: 'added', id: 'p-1' })
    replies.set('session:list', [{ sessionId: 's-1', summary: '一場', lastModified: 1 }])

    await expect(api.getProjects()).resolves.toEqual(VIEW)
    await expect(api.addProject()).resolves.toEqual({ kind: 'cancelled' })
    await expect(api.relocateProject('p-1')).resolves.toEqual({ kind: 'added', id: 'p-1' })
    await expect(api.listSessions({ projectId: 'p-1' })).resolves.toHaveLength(1)
    await expect(api.readPreview({ projectId: 'p1', path: 'a.md' })).resolves.toEqual({ kind: 'markdown', text: '# 標題' })
    expect(invoked.map((i) => i.channel)).toEqual(['projects:get', 'projects:add', 'projects:relocate', 'session:list', 'preview:read'])
    expect(invoked[2]?.payload).toEqual({ id: 'p-1' })
    expect(invoked[3]?.payload).toEqual({ projectId: 'p-1' })

    replies.set('projects:get', { projects: 'nope' })
    replies.set('projects:add', { kind: 'weird' })
    await expect(api.getProjects()).rejects.toThrow('projects:get 回傳的形狀不符')
    await expect(api.addProject()).rejects.toThrow('projects:add 回傳的形狀不符')
  })
})

  it('openConversation 送 conversations:open,payload 有 projectId 與 provider', async () => {
    const api = await loadBridge()
    api.openConversation('p-1', 'claude', '新功能')
    expect(sent.at(-1)).toEqual({ channel: 'conversations:open', payload: { projectId: 'p-1', provider: 'claude', worktreeName: '新功能' } })
    api.openConversation('p-1', 'codex')
    expect(sent.at(-1)).toEqual({ channel: 'conversations:open', payload: { projectId: 'p-1', provider: 'codex' } })
  })

it('onPeerState 訂閱 peer:state,回傳的函式取消訂閱', async () => {
  const api = await loadBridge()
  const off = api.onPeerState(() => {})
  expect(ipcRenderer.on).toHaveBeenCalledWith('peer:state', expect.any(Function))
  off()
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith('peer:state', expect.any(Function))
})

it('兩個動作送出對應的頻道與 payload', async () => {
  const api = await loadBridge()
  api.answerPeerAsUser({ questionId: 'q1', text: '答案' })
  expect(ipcRenderer.send).toHaveBeenCalledWith('peer:answer', { questionId: 'q1', text: '答案' })
  api.cancelPeer({ questionId: 'q1' })
  expect(ipcRenderer.send).toHaveBeenCalledWith('peer:cancel', { questionId: 'q1' })
})

it('getPeer 拉取未決快照並驗證回傳形狀', async () => {
  const api = await loadBridge()
  const state = { pending: [{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }] }
  replies.set('peer:get', state)
  await expect(api.getPeer()).resolves.toEqual(state)
  expect(invoked.at(-1)?.channel).toBe('peer:get')
  replies.set('peer:get', { pending: 'bad' })
  await expect(api.getPeer()).rejects.toThrow('peer:get 回傳的形狀不符')
})

it('getApprovals 驗證快照陣列與逐筆請求', async () => {
  const api = await loadBridge()
  const asks = [{ requestId: 'r', projectId: 'p', conversationId: 'c', toolUseId: 't', toolName: 'Bash', input: {} }]
  replies.set('approvals:get', asks)
  await expect(api.getApprovals()).resolves.toEqual(asks)
  expect(invoked.at(-1)?.channel).toBe('approvals:get')
  for (const bad of [null, [{}]]) {
    replies.set('approvals:get', bad)
    await expect(api.getApprovals()).rejects.toThrow('approvals:get 回傳的形狀不符')
  }
})


it('readPreview 重組 payload,錯誤回傳與 ipcRenderer 本體都不放行', async () => {
  const api = await loadBridge()
  const payload = { projectId: 'p1', path: 'a.md', extra: '不轉送' }
  replies.set('preview:read', { kind: 'markdown', text: '# 標題', extra: true })
  await expect(api.readPreview(payload)).resolves.toEqual({ kind: 'markdown', text: '# 標題' })
  expect(invoked.at(-1)).toEqual({ channel: 'preview:read', payload: { projectId: 'p1', path: 'a.md' } })
  expect(invoked.at(-1)?.payload).not.toBe(payload)
  replies.set('preview:read', { kind: 'image' })
  await expect(api.readPreview(payload)).rejects.toThrow('preview:read 回傳的形狀不符')
  replies.delete('preview:read')
  const result = api.readPreview(payload)
  expect(result).not.toBe(ipcRenderer)
  await expect(result).rejects.toThrow('preview:read 回傳的形狀不符')
})

it('listSessions 逐欄重組時保留 provider 並丟棄額外欄位', async () => {
  const api = await loadBridge()
  replies.set('session:list', [])
  const scope = { projectId: 'p', provider: 'codex' as const, extra: '不轉送' }
  await api.listSessions(scope)
  expect(invoked.at(-1)).toEqual({ channel: 'session:list', payload: { projectId: 'p', provider: 'codex' } })
  await api.listSessions({ projectId: null })
  expect(invoked.at(-1)).toEqual({ channel: 'session:list', payload: { projectId: null } })
})

it('translate 重組 payload,解析成功與拒絕結果,擋下錯誤形狀', async () => {
  const api = await loadBridge()
  const payload = { text: 'hi', target: 'ja', extra: true }
  replies.set('translate:run', { kind: 'ok', text: 'こんにちは', extra: true })
  await expect(api.translate(payload)).resolves.toEqual({ kind: 'ok', text: 'こんにちは' })
  expect(invoked.at(-1)).toEqual({ channel: 'translate:run', payload: { text: 'hi', target: 'ja' } })
  replies.set('translate:run', { kind: 'rejected', message: '忙碌中', extra: true })
  await expect(api.translate(payload)).resolves.toEqual({ kind: 'rejected', message: '忙碌中' })
  replies.set('translate:run', { kind: 'ok' })
  await expect(api.translate(payload)).rejects.toThrow('translate:run 回傳的形狀不符')
  replies.delete('translate:run')
  await expect(api.translate(payload)).rejects.toThrow('translate:run 回傳的形狀不符')
})

it('Skills invoke validates requests and responses without exposing ipcRenderer', async () => {
  const api = await loadBridge()
  replies.set('skills:manage', { kind: 'state', state: { revision: null, skills: [] } })
  expect(await api.manageSkills({ action: 'list' })).toEqual({ kind: 'state', state: { revision: null, skills: [] } })
  expect(invoked.at(-1)).toEqual({ channel: 'skills:manage', payload: { action: 'list' } })
  replies.set('skills:manage', { kind: 'state', state: { skills: 'wrong' } })
  await expect(api.manageSkills({ action: 'list' })).rejects.toThrow('Skills 回傳格式不正確')
  replies.delete('skills:manage')
})

it('manageTestMachines:請求先過 schema,回應過 schema,壞的回應 reject', async () => {
  const api = await loadBridge()
  replies.set('testMachines:manage', { kind: 'state', revision: 0, machines: [] })
  await expect(api.manageTestMachines({ action: 'list', projectId: 'p' })).resolves.toEqual({ kind: 'state', revision: 0, machines: [] })
  expect(invoked.at(-1)).toEqual({ channel: 'testMachines:manage', payload: { action: 'list', projectId: 'p' } })
  replies.set('testMachines:manage', { kind: 'state', revision: 0, machines: [{ id: 'm', name: 'a', url: 'https://a.test/', username: 'u', hasPassword: false, passwordNeedsReentry: false, password: 'leak' }] })
  await expect(api.manageTestMachines({ action: 'list', projectId: 'p' })).rejects.toThrow('測試機設定回傳格式不正確')
  replies.delete('testMachines:manage')
})

it('manageErrorIntake:請求與回應都經過 schema 驗證', async () => {
  const api = await loadBridge()
  const settings = { host: 'db.test', port: 3306, database: 'errors', tls: true, adminUsername: 'root', hasAdminPassword: true, hasAppPassword: false, schemaVersion: null, packageSource: '@yeschef/error-intake' }
  replies.set('errorIntake:manage', { kind: 'settings', settings })
  await expect(api.manageErrorIntake({ action: 'get' })).resolves.toEqual({ kind: 'settings', settings })
  expect(invoked.at(-1)).toEqual({ channel: 'errorIntake:manage', payload: { action: 'get' } })
  replies.set('errorIntake:manage', { kind: 'settings', settings: { ...settings, adminPasswordCiphertext: 'secret' } })
  await expect(api.manageErrorIntake({ action: 'get' })).rejects.toThrow('錯誤收集資料庫設定回傳格式不正確')
  replies.set('errorIntake:manage', { kind: 'copied', projectId: 'p1' })
  await expect(api.manageErrorIntake({ action: 'copy-connection', projectId: 'p1' })).resolves.toEqual({ kind: 'copied', projectId: 'p1' })
  expect(invoked.at(-1)).toEqual({ channel: 'errorIntake:manage', payload: { action: 'copy-connection', projectId: 'p1' } })
  replies.delete('errorIntake:manage')
})

it('manageGroup 送出的請求過 schema,回應也過 schema', async () => {
  const api = await loadBridge()
  replies.set('group:manage', { kind: 'sent', threadId: 't1' })
  await expect(api.manageGroup({ action: 'send', projectId: 'p1', threadId: 'general', text: '嗨' })).resolves.toEqual({ kind: 'sent', threadId: 't1' })
  expect(invoked.at(-1)).toEqual({ channel: 'group:manage', payload: { action: 'send', projectId: 'p1', threadId: 'general', text: '嗨' } })
  replies.set('group:manage', { kind: 'sent', threadId: 't1', extra: 1 })
  await expect(api.manageGroup({ action: 'get', projectId: 'p1' })).rejects.toThrow('群組回傳格式不正確')
})

it('onGroupMessages 回傳的是我們自己的解除訂閱,不是 ipcRenderer', () => {
  const api = exposed[0]!.value as YesChefApi
  const off = api.onGroupMessages(() => {})
  expect(typeof off).toBe('function')
  expect(off).not.toBe(ipcRenderer)
  off()
})

it('openGroup 只送 projectId', () => {
  const api = exposed[0]!.value as YesChefApi
  api.openGroup('p1')
  expect(sent.at(-1)).toEqual({ channel: 'group:open', payload: { projectId: 'p1' } })
})

it('worktreeMerge:請求先過 schema,回應過 schema,壞的回應 reject', async () => {
  const api = await loadBridge()
  replies.set('worktree:merge', { kind: 'aborted' })
  await expect(api.worktreeMerge({ action: 'abort', projectId: 'p', tabId: 't' })).resolves.toEqual({ kind: 'aborted' })
  expect(invoked.at(-1)).toEqual({ channel: 'worktree:merge', payload: { action: 'abort', projectId: 'p', tabId: 't' } })
  replies.set('worktree:merge', { kind: 'merged', target: 'main', branch: 'task', commits: 1, message: 'x', worktreePath: '/repo/.worktrees/task' })
  await expect(api.worktreeMerge({ action: 'merge', projectId: 'p', tabId: 't' })).rejects.toThrow('合併回傳格式不正確')
  replies.delete('worktree:merge')
})

describe('瀏覽器 IPC', () => {
  it('browserCommand 只送 kind 與 url,回傳值過 parser', async () => {
    const api = await loadBridge()
    replies.set('browser:command', { ok: false, message: '這不是網址' })
    const dirty = { kind: 'navigate', url: 'hello world', extra: 1 } as never
    await expect(api.browserCommand(dirty)).resolves.toEqual({ ok: false, message: '這不是網址' })
    expect(invoked.at(-1)).toEqual({ channel: 'browser:command', payload: { kind: 'navigate', url: 'hello world' } })
  })

  it('browserCommand 回傳形狀不符就 reject', async () => {
    const api = await loadBridge()
    replies.set('browser:command', { ok: 'yes' })
    await expect(api.browserCommand({ kind: 'back' })).rejects.toThrow('browser:command 回傳的形狀不符')
  })

  it('onBrowserState 丟掉形狀不符的 payload', async () => {
    const api = await loadBridge()
    const seen: unknown[] = []
    api.onBrowserState((s) => { seen.push(s) })
    const listener = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls.find((call: unknown[]) => call[0] === 'browser:state')?.[1] as (e: unknown, raw: unknown) => void
    listener({}, { conversationId: 'c1' })
    listener({}, { conversationId: 'c1', url: 'u', title: 't', loading: false, canGoBack: false, canGoForward: false })
    expect(seen).toHaveLength(1)
  })
})
