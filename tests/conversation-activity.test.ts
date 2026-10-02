import { expect, it, vi } from 'vitest'
import { writtenPaths, createClaudeActivityReader } from '../src/main/conversation-activity.js'
import type { Event } from '../src/shared/events.js'
const write = (id: string, path: string): Event => ({ kind: 'tool-use', id, name: 'Edit', input: { file_path: path, old_string: 'before', new_string: 'after' } })
const result = (id: string, isError = false): Event => ({ kind: 'tool-result', id, content: 'done', isError })
it('只有成功完成的寫檔算修改；讀取、提及、批准前、失敗、shell 指令都不推測', () => {
  const events: Event[] = [
    { kind: 'text', text: '修改了 service-b /work/service-b/x' },
    { kind: 'tool-use', id: 'read', name: 'Read', input: { file_path: '/work/service-b/x' } }, result('read'),
    { kind: 'tool-use', id: 'bash', name: 'Bash', input: { command: 'echo hello > /work/service-b/x' } }, result('bash'),
    write('failed', '/work/other/x'), result('failed', true), write('pending', '/work/pending/x'),
    write('edited', 'web-ui/x'), result('edited'), result('edited'),
  ]
  expect(writtenPaths({ groups: [events], warnings: [] }, '/work')).toEqual(['/work/web-ui/x'])
})
it('不同子 agent 不交叉配對 tool ID；reset 與 cwd 尊重實際對話邊界', () => {
  expect(writtenPaths({ groups: [[write('same', '/work/wrong')], [result('same')]], warnings: [] }, '/work')).toEqual([])
  expect(writtenPaths({ groups: [[write('old', '/work/old'), result('old'), { kind: 'reset' }, { kind: 'session-start', sessionId: 'new', cwd: '/work/new' }, write('w', 'x'), result('w')]], warnings: [] }, '/work')).toEqual(['/work/new/x'])
})
it('Codex completed changes 與獨立 apply_patch 的新增／移動路徑可追溯', () => {
  const events: Event[] = [
    { kind: 'tool-use', id: 'c', name: 'Edit', input: { changes: [{ path: '/work/a/old', kind: { type: 'update', move_path: '/work/b/new' } }] } },
    { kind: 'tool-result', id: 'c', isError: false, content: { status: 'completed' } },
    { kind: 'tool-use', id: 'p', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: docs/new.md\n+hello\n*** End Patch' } }, result('p'),
  ]
  expect(writtenPaths({ groups: [events], warnings: [] }, '/work')).toEqual(['/work/a/old', '/work/b/new', '/work/docs/new.md'])
})
it('子 agent 使用父 session 的 SDK 關聯，不掃其他專案歷史；失敗明示不完整', async () => {
  const getSubagentMessages = vi.fn(async (_id: string, agent: string) => { if (agent === 'bad') throw Error('missing'); return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/work/repo/x' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'done', is_error: false }] } }] })
  const read = createClaudeActivityReader({ getSessionMessages: async () => [], listSubagents: async () => ['child', 'bad'], getSubagentMessages })
  const activity = await read('parent')
  expect(getSubagentMessages).toHaveBeenCalledWith('parent', 'child', { limit: 10000 })
  expect(writtenPaths(activity, '/work')).toEqual(['/work/repo/x'])
  expect(activity.warnings).toHaveLength(1)
})
