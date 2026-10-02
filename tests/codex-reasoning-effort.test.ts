import { expect, it } from 'vitest'
import { createCodexClient, type CodexProcess, type SpawnCodex } from '../src/main/codex/client.js'
import { selectCodexReasoningEffort, type CodexReasoningEffortOption } from '../src/main/codex/reasoning-effort.js'

const gpt55Efforts: readonly CodexReasoningEffortOption[] = [
  { reasoningEffort: 'none', description: '' },
  { reasoningEffort: 'low', description: '' },
  { reasoningEffort: 'medium', description: '' },
  { reasoningEffort: 'high', description: '' },
  { reasoningEffort: 'xhigh', description: '' },
]

it('把 max 夾到模型支援的最高一級 xhigh', () => {
  expect(selectCodexReasoningEffort('max', gpt55Efforts, 'medium')).toBe('xhigh')
})

it('全域 effort 在模型支援清單內時照用', () => {
  expect(selectCodexReasoningEffort('high', gpt55Efforts, 'medium')).toBe('high')
})

it('模型支援清單為空時不指定 effort', () => {
  expect(selectCodexReasoningEffort('max', [], 'medium')).toBeUndefined()
})

it('讀不到全域 effort 時不指定 effort', () => {
  expect(selectCodexReasoningEffort(undefined, gpt55Efforts, 'medium')).toBeUndefined()
})

it('gpt-5.5 的 turn/start 帶夾過的 xhigh', async () => {
  const effort = selectCodexReasoningEffort('max', gpt55Efforts, 'medium')
  const sent: Array<Record<string, unknown>> = []
  let onLine: (line: string) => void = () => {}
  const spawn: SpawnCodex = (): CodexProcess => ({
    write(line) {
      const request = JSON.parse(line) as Record<string, unknown>
      sent.push(request)
      const method = request['method']
      if (typeof request['id'] !== 'number' || typeof method !== 'string') return
      const result = method === 'thread/start' ? { thread: { id: 'thread-1' } } : {}
      queueMicrotask(() => onLine(`${JSON.stringify({ jsonrpc: '2.0', id: request['id'], result })}\n`))
    },
    closeStdin() {}, kill() {}, onLine(callback) { onLine = callback }, onStderr() {}, onError() {}, onExit() {},
  })
  const client = createCodexClient({
    cwd: '/p', model: 'gpt-5.5', effort,
    logError() {}, onEvents() {}, onApproval: async () => 'accept', onExit() {}, spawn,
  })

  await client.start()
  await client.send('檢查支援範圍')

  const turn = sent.find((request) => request['method'] === 'turn/start')
  expect(turn?.['params']).toMatchObject({ threadId: 'thread-1', effort: 'xhigh' })
  await client.teardown()
})
