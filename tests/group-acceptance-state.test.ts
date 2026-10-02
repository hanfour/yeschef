import { expect, it } from 'vitest'
import { currentCodexWorker, groupDomRowsEqual, hasVisibleGroupText, inputTurnCountsByParticipant, participantsWithNewInputTurn, takeUnseenRequestRecords, type ChefTask, type GroupDomRow, type GroupMessage } from '../spikes/group-acceptance-state.js'

const input = '@不存在的人 [group-acceptance run-1] 這句話不可送給任何人。'

it('跨掃描與 detail 依 requestId 只記錄一次批准卡', () => {
  const seen = new Set<string>()
  const first = { requestId: 'request-1', toolName: 'Edit' }
  const next = { requestId: 'request-2', toolName: 'Write' }
  expect(takeUnseenRequestRecords([first, first], seen)).toEqual([first])
  expect(takeUnseenRequestRecords([first, next], seen)).toEqual([next])
})

function task(attemptEvents: Readonly<Record<string, readonly unknown[]>>): ChefTask {
  return {
    id: 'task-1', goal: '驗收', status: 'running', policy: { allowed: [] }, units: [], reason: '',
    attempts: Object.entries(attemptEvents).map(([workerId, events], index) => ({
      id: `attempt-${index}`, unitId: 'unit-1', workerId, provider: 'codex', model: 'm', status: 'running', startedAt: index, events,
    })),
  }
}

it('只比對 participant 新增的目標 user-text，不受 assistant 或其他 user turn 影響', () => {
  const before = task({ chef: [{ kind: 'user-text', text: '原始目標' }], worker: [{ kind: 'user-text', text: '工作內容' }] })
  const after = task({
    chef: [...before.attempts[0]!.events!, { kind: 'text', text: '主廚仍在回覆' }],
    worker: [...before.attempts[1]!.events!, { kind: 'user-text', text: '另一則訊息' }],
  })
  expect(participantsWithNewInputTurn(before, after, input)).toEqual([])
  expect(inputTurnCountsByParticipant(after, input)).toEqual([])
})

it('回報哪個 participant 新增了以該群組訊息為輸入的 user turn', () => {
  const before = task({ chef: [], worker: [] })
  const after = task({ chef: [], worker: [{ kind: 'user-text', text: `[群組 · 你]\n${input}` }] })
  expect(participantsWithNewInputTurn(before, after, input)).toEqual(['worker'])
  expect(inputTurnCountsByParticipant(after, input)).toEqual([{ conversationId: 'worker', count: 1 }])
})

function workerEvent(kind: 'joined' | 'left', conversationId: string, label: string, unitId = 'unit-1'): GroupMessage {
  return {
    id: `${kind}-${conversationId}`, projectId: 'project-1', threadId: 'thread-1', at: 1,
    from: { kind: 'agent', conversationId, label, provider: 'codex', role: 'worker' },
    kind, text: label, mentions: [], unitId,
  }
}

it.each([
  { name: '沒有改派', messages: [workerEvent('joined', 'codex-0', 'codex-0', 'other-unit'), workerEvent('joined', 'codex-1', 'codex-1')], expected: { conversationId: 'codex-1', label: 'codex-1' } },
  { name: '改派一次', messages: [workerEvent('joined', 'codex-1', 'codex-1'), workerEvent('left', 'codex-1', 'codex-1'), workerEvent('joined', 'codex-2', 'codex-2')], expected: { conversationId: 'codex-2', label: 'codex-2' } },
  { name: '改派兩次', messages: [workerEvent('joined', 'codex-1', 'codex-1'), workerEvent('left', 'codex-1', 'codex-1'), workerEvent('joined', 'codex-2', 'codex-2'), workerEvent('left', 'codex-2', 'codex-2'), workerEvent('joined', 'codex-3', 'codex-3')], expected: { conversationId: 'codex-3', label: 'codex-3' } },
  { name: '全部離開', messages: [workerEvent('joined', 'codex-1', 'codex-1'), workerEvent('left', 'codex-1', 'codex-1')], expected: undefined },
])('取得目前 Codex worker：$name', ({ messages, expected }) => {
  expect(currentCodexWorker(messages, 'unit-1')).toEqual(expected)
})

it.each([
  { name: '單行', visible: 'worker replied in one line', expected: 'replied in one line' },
  { name: '多行', visible: 'worker replied  \n with a second line', expected: 'replied\n  with a second line' },
  { name: '引號與反斜線', visible: 'worker said "keep \\ this path"', expected: 'said "keep \\ this path"' },
])('結構化 DOM 列可比對$name', ({ visible, expected }) => {
  const rows: readonly GroupDomRow[] = [{ from: 'codex-2', text: visible }]
  expect(hasVisibleGroupText(rows, expected)).toBe(true)
})

it('完整 DOM 列比較維持發話者與順序，並正規化兩側文字空白', () => {
  expect(groupDomRowsEqual(
    [{ from: 'codex-2', text: 'first\n  message' }, { from: '系統', text: 'second' }],
    [{ from: 'codex-2', text: 'first message' }, { from: '系統', text: 'second' }],
  )).toBe(true)
  expect(groupDomRowsEqual([{ from: 'codex-2', text: 'message' }], [{ from: 'codex-1', text: 'message' }])).toBe(false)
})
