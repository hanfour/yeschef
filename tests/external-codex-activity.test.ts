import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codexLaunch, completedPatchPaths, recoverExternalCodexWrites } from '../src/main/external-codex-activity.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const patch = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: app/a.rb\n-old\n+new\n*** End Patch\nPATCH"
const output = 'Process exited with code 0\nOutput:\nSuccess. Updated the following files:\nM app/a.rb\n'
const items = (cwd: string, cmd = patch, result = output) => [
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'patch', arguments: JSON.stringify({ cmd, workdir: cwd }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'patch', output: result } },
]
it('只解析明確的 Codex launch，拒絕相對路徑、動態路徑與其他命令', () => {
  expect(codexLaunch('codex exec --cd "/workspace/my repo" -m selected -o /tmp/result "task" > /tmp/out.log 2>&1')).toEqual({ cwd: '/workspace/my repo', output: '/tmp/out.log' })
  expect(codexLaunch('echo codex exec --cd /repo > /tmp/out.log 2>&1')).toBeNull()
  expect(codexLaunch('codex exec --cd "$WORK" > /tmp/out.log 2>&1')).toBeNull()
  expect(codexLaunch('codex exec --cd relative > /tmp/out.log 2>&1')).toBeNull()
})
it('patch 呼叫、成功結果與輸出檔案三者必須對應，尊重 command cwd', () => {
  expect(completedPatchPaths(items('/actual'), '/session')).toEqual(['/actual/app/a.rb'])
  expect(completedPatchPaths(items('/actual', `echo '${patch}'`), '/session')).toEqual([])
  expect(completedPatchPaths(items('/actual', patch, output.replace('code 0', 'code 1')), '/session')).toEqual([])
  expect(completedPatchPaths(items('/actual', patch, output.replace('app/a.rb', 'unrelated.rb')), '/session')).toEqual([])
})
it('從已執行的父工具連到子 session，驗證身分／時間／cwd 後恢復實際寫檔', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-external-')); roots.push(root)
  const cwd = join(root, 'repo'); await mkdir(cwd)
  const childId = '01a0c24c-4d22-78a2-9543-498ba5752e25'
  const stamp = parseInt(childId.replaceAll('-', '').slice(0, 12), 16)
  const folder = join(root, 'sessions', new Date(stamp).toISOString().slice(0,10).replaceAll('-', '/')); await mkdir(folder, { recursive: true })
  const child = join(folder, `rollout-${childId}.jsonl`), log = join(root, 'stdout.log'), parent = join(root, 'parent.jsonl')
  await writeFile(log, `session id: ${childId}\n`)
  const task = 'Update app/a.rb for the delegated task.'
  const childRows = [{ type: 'session_meta', payload: { id: childId, source: 'exec', cwd } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: task }] } }, ...items(cwd)]
  await writeFile(child, childRows.map(r => JSON.stringify(r)).join('\n'))
  const taskFile = join(root, 'task.md')
  const records = [
    { type: 'assistant', timestamp: new Date(stamp-1500).toISOString(), sessionId: 'parent', message: { content: [{ type: 'tool_use', id: 'task-write', name: 'Write', input: { file_path: taskFile, content: task } }] } },
    { type: 'user', sessionId: 'parent', message: { content: [{ type: 'tool_result', tool_use_id: 'task-write', is_error: false, content: 'written' }] } },
    { type: 'assistant', timestamp: new Date(stamp-1000).toISOString(), sessionId: 'parent', message: { content: [{ type: 'tool_use', id: 'launch', name: 'Bash', input: { command: `codex exec --cd ${cwd} -m auto "$(cat ${taskFile})" > ${log} 2>&1` } }] } },
    { type: 'user', sessionId: 'parent', message: { content: [{ type: 'tool_result', tool_use_id: 'launch', is_error: false, content: 'Running in background' }] } },
  ]
  const save = () => writeFile(parent, records.map(r => JSON.stringify(r)).join('\n'))
  await save()
  const request = { parentSessionId: 'parent', transcriptPath: parent, codexHome: root }
  expect((await recoverExternalCodexWrites(request)).writes).toEqual([{ parentSessionId: 'parent', toolUseId: 'launch', childSessionId: childId, cwd, paths: [join(cwd, 'app/a.rb')], taskHash: expect.stringMatching(/^[a-f0-9]{64}$/) }])
  expect((await recoverExternalCodexWrites({ ...request, parentSessionId: 'other' })).writes).toEqual([])
  await writeFile(child, childRows.map(r => JSON.stringify(r).replace(task, 'An unrelated task.')).join('\n'))
  expect((await recoverExternalCodexWrites(request)).writes).toEqual([])
  await writeFile(child, childRows.map(r => JSON.stringify(r)).join('\n'))
  records[2]!.timestamp = new Date(stamp + 60000).toISOString(); await save()
  expect((await recoverExternalCodexWrites(request)).writes).toEqual([])
})
