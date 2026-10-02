import { describe, it, expect } from 'vitest'
import {
  IPC,
  parseTranslate,
  parseTranslateResult,
  parsePreviewRead,
  parsePreviewReadResult,
  parseBrowserBounds,
  parsePeerAction,
  parsePeerState,
  MAX_INPUT_LENGTH,
  parseApprovalAsk,
  parseApprovalSettled,
  parseApprovalReply,
  parseEventsBatch,
  parseEventsBatchPayload,
  parseSessionStatePayload,
  parseHandoffDone,
  parseIntentOpenHistory,
  parseSessionState,
  parseSessionSummaries,
  parseUserInput,
  parseTerminalEndpoint,
} from '../src/shared/ipc.js'

describe('IPC 頻道名稱與契約一致', () => {
  it('頻道逐字比對', () => {
    expect(IPC).toEqual({
      previewRead: 'preview:read',
      translateRun: 'translate:run',
      approvalsGet: 'approvals:get',
      peerGet: 'peer:get',
      peerState: 'peer:state',
      peerAnswer: 'peer:answer',
      peerCancel: 'peer:cancel',
      browserBounds: 'layout:browser-bounds',
      browserCommand: 'browser:command',
      browserState: 'browser:state',
      browserSessions: 'browser:sessions',
      browserGet: 'browser:get',
      eventsBatch: 'agent:events',
      groupMessages: 'group:messages',
      groupOpen: 'group:open',
      userInput: 'agent:input',
      approvalAsk: 'agent:approval:ask',
      approvalReply: 'agent:approval:reply',
      approvalSettled: 'agent:approval:settled',
      sessionList: 'session:list',
      sessionState: 'session:state',
      intentStartNew: 'session:intent:start-new',
      intentOpenHistory: 'session:intent:open-history',
      handoffDone: 'handoff:done',
      terminalEndpoint: 'terminal:endpoint',
      projectsGet: 'projects:get',
      projectsState: 'projects:state',
      projectsAdd: 'projects:add',
      projectsRelocate: 'projects:relocate',
      projectsRemove: 'projects:remove',
      projectsActivate: 'projects:activate',
      tabsOpen: 'tabs:open',
      tabsClose: 'tabs:close',
      tabsActivate: 'tabs:activate',
      conversationsOpen: 'conversations:open',
    })
  })
})

describe('parseTerminalEndpoint', () => {
  it('接受 { port, token }', () => {
    expect(parseTerminalEndpoint({ port: 51234, token: 'secret' })).toEqual({ port: 51234, token: 'secret' })
  })
  it('port 不是數字回 null', () => {
    expect(parseTerminalEndpoint({ port: '51234' })).toBeNull()
    expect(parseTerminalEndpoint(null)).toBeNull()
    expect(parseTerminalEndpoint({})).toBeNull()
  })
  it('缺 token、token 非字串或空字串都回 null', () => {
    expect(parseTerminalEndpoint({ port: 51234 })).toBeNull()
    expect(parseTerminalEndpoint({ port: 51234, token: 42 })).toBeNull()
    expect(parseTerminalEndpoint({ port: 51234, token: '' })).toBeNull()
  })
})

describe('parseUserInput', () => {
  it('接受一般字串', () => {
    expect(parseUserInput('你好')).toBe('你好')
  })
  it('空字串回 null（沒有東西可送給 SDK）', () => {
    expect(parseUserInput('')).toBeNull()
  })
  it('非字串一律回 null', () => {
    for (const bad of [null, undefined, 42, {}, [], true, { text: 'hi' }]) {
      expect(parseUserInput(bad)).toBeNull()
    }
  })
  it('超過上限回 null（擋住整包貼上的巨型 payload）', () => {
    expect(parseUserInput('a'.repeat(MAX_INPUT_LENGTH))).not.toBeNull()
    expect(parseUserInput('a'.repeat(MAX_INPUT_LENGTH + 1))).toBeNull()
  })
})

describe('parseApprovalReply', () => {
  it('allow 與 deny 都接受，且回傳新物件（不把外來物件直接放行）', () => {
    const raw = { requestId: 'r-1', decision: 'allow', 額外欄位: '應被丟掉' }
    expect(parseApprovalReply(raw)).toEqual({ requestId: 'r-1', decision: 'allow' })
    expect(parseApprovalReply({ requestId: 'r-2', decision: 'deny' })).toEqual({
      requestId: 'r-2',
      decision: 'deny',
    })
  })
  it('decision 不是 allow/deny 回 null', () => {
    for (const d of ['yes', 'ALLOW', '', 1, null, undefined]) {
      expect(parseApprovalReply({ requestId: 'r-1', decision: d })).toBeNull()
    }
  })
  it('requestId 缺漏或非字串回 null', () => {
    expect(parseApprovalReply({ decision: 'allow' })).toBeNull()
    expect(parseApprovalReply({ requestId: '', decision: 'allow' })).toBeNull()
    expect(parseApprovalReply({ requestId: 7, decision: 'allow' })).toBeNull()
  })
  it('非物件回 null（陣列也算非物件）', () => {
    for (const bad of [null, undefined, 'r-1', 3, []]) {
      expect(parseApprovalReply(bad)).toBeNull()
    }
  })
})

describe('parseIntentOpenHistory', () => {
  it('接受帶 sessionId 的物件', () => {
    expect(parseIntentOpenHistory({ sessionId: 's-1' })).toEqual({ sessionId: 's-1' })
  })
  it('空字串或缺漏回 null', () => {
    expect(parseIntentOpenHistory({ sessionId: '' })).toBeNull()
    expect(parseIntentOpenHistory({})).toBeNull()
    expect(parseIntentOpenHistory('s-1')).toBeNull()
  })
})

describe('parseHandoffDone', () => {
  it('接受帶 toolUseId 的物件，並回傳新物件（額外欄位被丟掉）', () => {
    const raw = { toolUseId: 'toolu_1', 額外欄位: '應被丟掉' }
    const parsed = parseHandoffDone(raw)
    expect(parsed).toEqual({ toolUseId: 'toolu_1' })
    expect(parsed).not.toBe(raw)
  })
  it('toolUseId 缺漏、空字串或非字串回 null', () => {
    expect(parseHandoffDone({})).toBeNull()
    expect(parseHandoffDone({ toolUseId: '' })).toBeNull()
    expect(parseHandoffDone({ toolUseId: 7 })).toBeNull()
  })
  it('非物件回 null（陣列也算非物件）', () => {
    for (const bad of [null, undefined, 'toolu_1', 3, []]) {
      expect(parseHandoffDone(bad)).toBeNull()
    }
  })
})

describe('parseApprovalAsk（main → renderer，preload 側驗證）', () => {
  it('input 可以是任何值，但 requestId、toolUseId 與 toolName 必須是非空字串', () => {
    expect(
      parseApprovalAsk({ requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1', toolUseId: 'toolu_1', toolName: 'Bash', input: null })
    ).toEqual({
      requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: null,
    })
    expect(
      parseApprovalAsk({ requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1', toolUseId: 'toolu_1', toolName: '', input: {} })
    ).toBeNull()
    expect(parseApprovalAsk({ projectId: 'p-1', conversationId: 'c-1', toolUseId: 'toolu_1', toolName: 'Bash', input: {} })).toBeNull()
  })

  it('裁決 28：缺 toolUseId 判為無效，型別不對也一樣', () => {
    expect(parseApprovalAsk({ requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1', toolName: 'Bash', input: {} })).toBeNull()
    expect(
      parseApprovalAsk({ requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1', toolUseId: '', toolName: 'Bash', input: {} })
    ).toBeNull()
    expect(
      parseApprovalAsk({ requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1', toolUseId: 7, toolName: 'Bash', input: {} })
    ).toBeNull()
  })

  it('裁決 11：title 與 displayName 是選填字串，會被帶過去', () => {
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        title: 'Claude 想執行 ls',
        displayName: '執行指令',
      })
    ).toEqual({
      requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: {},
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })
  })

  it('沒帶 title／displayName 時不憑空補上欄位', () => {
    const parsed = parseApprovalAsk({
      requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: {},
    })
    expect(parsed).not.toHaveProperty('title')
    expect(parsed).not.toHaveProperty('displayName')
  })

  it('title／displayName 不是字串時整筆回 null，不默默丟掉那個欄位', () => {
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        title: 7,
      })
    ).toBeNull()
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
      projectId: 'p-1', conversationId: 'c-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        displayName: {},
      })
    ).toBeNull()
  })
})

describe('parseEventsBatch', () => {
  it('接受一串帶 kind 的物件，並保持順序與筆數', () => {
    const batch = [
      { kind: 'text-delta', messageId: 'm-1', index: 0, text: 'a' },
      { kind: 'block-stop', messageId: 'm-1', index: 0 },
    ]
    expect(parseEventsBatch(batch)).toEqual(batch)
  })
  it('空陣列回 null（不該有空批次送到 renderer）', () => {
    expect(parseEventsBatch([])).toBeNull()
  })
  it('任何一筆缺 kind，整批回 null', () => {
    expect(parseEventsBatch([{ kind: 'text', text: 'a' }, { text: 'b' }])).toBeNull()
  })
  it('非陣列回 null', () => {
    for (const bad of [null, undefined, {}, 'text', 5]) {
      expect(parseEventsBatch(bad)).toBeNull()
    }
  })
})

describe('parseSessionState（裁決 14：物件不是字串）', () => {
  it('三種 kind 各自回新造的物件', () => {
    expect(parseSessionState({ kind: 'idle' })).toEqual({ kind: 'idle' })
    expect(parseSessionState({ kind: 'live' })).toEqual({ kind: 'live' })
    expect(parseSessionState({ kind: 'live', sessionId: 's-1' })).toEqual({
      kind: 'live',
      sessionId: 's-1',
    })
    expect(parseSessionState({ kind: 'viewing', sessionId: 's-1' })).toEqual({
      kind: 'viewing',
      sessionId: 's-1',
    })
  })

  it('viewing 一定要有非空 sessionId', () => {
    expect(parseSessionState({ kind: 'viewing' })).toBeNull()
    expect(parseSessionState({ kind: 'viewing', sessionId: '' })).toBeNull()
    expect(parseSessionState({ kind: 'viewing', sessionId: 3 })).toBeNull()
  })

  it('live 的 sessionId 可以省略，但給了就必須是非空字串', () => {
    expect(parseSessionState({ kind: 'live', sessionId: '' })).toBeNull()
    expect(parseSessionState({ kind: 'live', sessionId: 3 })).toBeNull()
  })

  it('舊的字串形式一律回 null（renderer 拿到舊 bundle 時不能靜默通過）', () => {
    for (const bad of ['idle', 'live', 'viewing', { kind: 'busy' }, null, []]) {
      expect(parseSessionState(bad)).toBeNull()
    }
  })

  it('回的是新物件，額外欄位被切掉', () => {
    const raw = { kind: 'viewing', sessionId: 's-1', 額外欄位: '應被丟掉' }
    const parsed = parseSessionState(raw)
    expect(parsed).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(parsed).not.toBe(raw)
  })
})

describe('parseSessionSummaries', () => {
  it('接受合法清單並只留契約的六個欄位', () => {
    const raw = [
      {
        sessionId: 's-1',
        summary: '修 bug',
        lastModified: 1,
        cwd: '/p',
        customTitle: '我的標題',
        gitBranch: 'main',
        fileSize: 99,
      },
      { sessionId: 's-2', summary: '寫測試', lastModified: 2 },
    ]
    expect(parseSessionSummaries(raw)).toEqual([
      {
        sessionId: 's-1',
        summary: '修 bug',
        lastModified: 1,
        cwd: '/p',
        customTitle: '我的標題',
        gitBranch: 'main',
      },
      { sessionId: 's-2', summary: '寫測試', lastModified: 2 },
    ])
  })
  it('選填欄位型別不符時整份回 null，不默默丟掉那一筆', () => {
    const base = { sessionId: 's-1', summary: 'a', lastModified: 1 }
    expect(parseSessionSummaries([{ ...base, customTitle: 7 }])).toBeNull()
    expect(parseSessionSummaries([{ ...base, gitBranch: [] }])).toBeNull()
    expect(parseSessionSummaries([{ ...base, cwd: 1 }])).toBeNull()
  })
  it('空陣列是合法的（使用者可能真的沒有歷史對話）', () => {
    expect(parseSessionSummaries([])).toEqual([])
  })
  it('任何一筆形狀不符，整份回 null', () => {
    expect(parseSessionSummaries([{ sessionId: 's-1', summary: 'a' }])).toBeNull()
    expect(parseSessionSummaries([{ summary: 'a', lastModified: 1 }])).toBeNull()
    expect(parseSessionSummaries('s-1')).toBeNull()
  })
})

describe('parseApprovalAsk 的 projectId 與 parseApprovalSettled', () => {
  it('conversationId 缺或空字串整筆拒絕', () => {
    const base = { requestId: 'r', projectId: 'p', toolUseId: 't', toolName: 'Bash', input: {} }
    expect(parseApprovalAsk(base)).toBeNull()
    expect(parseApprovalAsk({ ...base, conversationId: '' })).toBeNull()
    expect(parseApprovalAsk({ ...base, conversationId: 'c-1' })?.conversationId).toBe('c-1')
  })

  const base = { conversationId: 'c-1', requestId: 'r-1', toolUseId: 't-1', toolName: 'Bash', input: {} }

  it('projectId 必填:缺席或空字串整筆回 null', () => {
    expect(parseApprovalAsk(base)).toBeNull()
    expect(parseApprovalAsk({ ...base, projectId: '' })).toBeNull()
    expect(parseApprovalAsk({ ...base, projectId: 'p-1' })?.projectId).toBe('p-1')
  })

  it('parseApprovalSettled 只認非空字串的 requestId', () => {
    expect(parseApprovalSettled({ requestId: 'r-1' })).toEqual({ requestId: 'r-1' })
    expect(parseApprovalSettled({ requestId: '' })).toBeNull()
    expect(parseApprovalSettled({})).toBeNull()
    expect(parseApprovalSettled('r-1')).toBeNull()
  })
})

describe('parseEventsBatchPayload', () => {
  const events = [{ kind: 'user-text', text: 'hi' }]
  it('conversationId 非空且 events 非空陣列才通過', () => {
    expect(parseEventsBatchPayload({ conversationId: 'c-1', events })).toEqual({ conversationId: 'c-1', events })
    expect(parseEventsBatchPayload({ conversationId: '', events })).toBeNull()
    expect(parseEventsBatchPayload({ events })).toBeNull()
    expect(parseEventsBatchPayload({ conversationId: 'c-1', events: [] })).toBeNull()
    expect(parseEventsBatchPayload(events)).toBeNull()
  })
})

describe('parseSessionStatePayload', () => {
  it('包一層 conversationId,state 沿用 parseSessionState 的規則', () => {
    expect(parseSessionStatePayload({ conversationId: 'c-1', state: { kind: 'idle' } })).toEqual({ conversationId: 'c-1', state: { kind: 'idle' } })
    expect(parseSessionStatePayload({ conversationId: 'c-1', state: { kind: 'viewing' } })).toBeNull()
    expect(parseSessionStatePayload({ conversationId: '', state: { kind: 'idle' } })).toBeNull()
    expect(parseSessionStatePayload({ kind: 'idle' })).toBeNull()
  })
})

it('同伴問答的三個頻道名稱', () => {
  expect(IPC.peerState).toBe('peer:state')
  expect(IPC.peerAnswer).toBe('peer:answer')
  expect(IPC.peerCancel).toBe('peer:cancel')
})

it('parsePeerAction 只收得下形狀正確的 payload', () => {
  expect(parsePeerAction({ questionId: 'q1' })).toEqual({ questionId: 'q1' })
  expect(parsePeerAction({ questionId: 'q1', text: '答案' })).toEqual({ questionId: 'q1', text: '答案' })
  expect(parsePeerAction({ questionId: '' })).toBeNull()
  expect(parsePeerAction({ questionId: 'q1', text: 3 })).toBeNull()
  expect(parsePeerAction(null)).toBeNull()
  expect(parsePeerAction('q1')).toBeNull()
})


describe('parsePeerState 的 targetProvider', () => {
  const item = { questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }

  it.each(['claude', 'codex', 'grok'])('保留合法的 %s', (targetProvider) => {
    const state = { pending: [{ ...item, targetProvider }] }
    expect(parsePeerState(state)).toEqual(state)
  })

  it.each([undefined, null, '', 'other', 'gemini', 1])('拒絕缺少或不合法的 provider: %s', (targetProvider) => {
    expect(parsePeerState({ pending: [{ ...item, targetProvider }] })).toBeNull()
  })
})

describe('parseBrowserBounds', () => {
  it('矩形與 null 都收', () => {
    expect(parseBrowserBounds({ rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ rect: { x: 1, y: 2, width: 3, height: 4 } })
    expect(parseBrowserBounds({ rect: null })).toEqual({ rect: null })
  })

  it('多出來的欄位切掉', () => {
    expect(parseBrowserBounds({ rect: { x: 1, y: 2, width: 3, height: 4, z: 9 }, extra: 1 })).toEqual({ rect: { x: 1, y: 2, width: 3, height: 4 } })
  })

  it('負數、NaN、Infinity、缺欄位、不是物件都不收', () => {
    expect(parseBrowserBounds({ rect: { x: -1, y: 0, width: 1, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: Number.NaN, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: 1 } })).toBeNull()
    expect(parseBrowserBounds({})).toBeNull()
    expect(parseBrowserBounds('x')).toBeNull()
  })
})


describe('preview parsers', () => {
  it('payload 只留下新的合法欄位', () => {
    const raw = { projectId: 'p1', path: 'a.md', extra: true }
    expect(parsePreviewRead(raw)).toEqual({ projectId: 'p1', path: 'a.md' })
    expect(parsePreviewRead(raw)).not.toBe(raw)
    for (const bad of [null, [], {}, { projectId: '', path: 'a.md' }, { projectId: 1, path: 'a.md' }, { projectId: 'p1', path: '' }, { projectId: 'p1', path: 1 }]) {
      expect(parsePreviewRead(bad)).toBeNull()
    }
  })

  it('三種結果逐欄重建,空內容也合法', () => {
    for (const value of [
      { kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' },
      { kind: 'markdown', text: '' },
      { kind: 'rejected', message: 'fake' },
    ]) {
      const raw = { ...value, extra: true }
      expect(parsePreviewReadResult(raw)).toEqual(value)
      expect(parsePreviewReadResult(raw)).not.toBe(raw)
    }
  })

  it('未知 kind、缺欄位或非字串不收', () => {
    for (const bad of [null, [], {}, { kind: 'unknown' }, { kind: 'image' }, { kind: 'image', mimeType: 'image/png' }, { kind: 'image', mimeType: 1, dataBase64: '' }, { kind: 'image', mimeType: 'image/png', dataBase64: 1 }, { kind: 'markdown' }, { kind: 'markdown', text: 1 }, { kind: 'rejected' }, { kind: 'rejected', message: 1 }]) {
      expect(parsePreviewReadResult(bad)).toBeNull()
    }
  })
})

describe('translate parsers', () => {
  it('只收非空文字與允許清單內的語言,並重組 payload', () => {
    for (const target of ['zh-Hant', 'en', 'ja', 'ko', 'zh-Hans']) {
      const raw = { text: ' hi ', target, extra: 1 }
      expect(parseTranslate(raw)).toEqual({ text: ' hi ', target })
      expect(parseTranslate(raw)).not.toBe(raw)
    }
    for (const raw of [null, [], 1, {}, { text: 1, target: 'ja' },
      { text: '', target: 'ja' }, { text: '  \n', target: 'ja' },
      { text: 'hi', target: 'fr' }, { text: 'hi' }, { text: 'hi', target: 1 }]) {
      expect(parseTranslate(raw)).toBeNull()
    }
  })
  it('認得 ok 與 rejected,其餘回 null', () => {
    for (const value of [{ kind: 'ok', text: '你好' }, { kind: 'ok', text: '' },
      { kind: 'rejected', message: '失敗' }]) {
      const raw = { ...value, extra: 1 }
      expect(parseTranslateResult(raw)).toEqual(value)
      expect(parseTranslateResult(raw)).not.toBe(raw)
    }
    for (const raw of [null, [], {}, { kind: 'other' }, { kind: 'ok' },
      { kind: 'ok', text: 1 }, { kind: 'rejected' }, { kind: 'rejected', message: 1 }]) {
      expect(parseTranslateResult(raw)).toBeNull()
    }
  })
})
