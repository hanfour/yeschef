import { expect, it } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createActivityLedger } from '../src/main/activity-ledger.js'
it('成功歸屬在壓縮／reset／重啟後保留，不保存程式內容且不同 session 隔離', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yeschef-activity-ledger-'))
  try {
    const errors: Error[] = [], ledger = createActivityLedger(dir, e => errors.push(e))
    ledger.observe('claude:a', '/work', [{ kind: 'tool-use', id: 'w', name: 'Write', input: { file_path: 'repo/a', content: 'private contents' } }, { kind: 'tool-result', id: 'w', isError: false, content: 'ok' }])
    ledger.observe('claude:a', '/work', [{ kind: 'reset' }])
    ledger.observe('claude:b', '/work', [{ kind: 'tool-use', id: 'w', name: 'Write', input: { file_path: 'other/b' } }, { kind: 'tool-result', id: 'w', isError: true, content: 'denied' }])
    await ledger.dispose()
    const restored = createActivityLedger(dir, e => errors.push(e))
    restored.record('claude:a', ['/work/repo/new']) // merges with disk even if loading has not finished
    expect((await restored.read('claude:a')).sort()).toEqual(['/work/repo/a', '/work/repo/new'])
    expect(await restored.read('claude:b')).toEqual([])
    await restored.dispose()
    for (const name of await readdir(dir)) expect(await readFile(join(dir, name), 'utf8')).not.toContain('private contents')
    expect(errors).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
