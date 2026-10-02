import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fetchSkillRepository } from '../src/main/skills/github.js'

const sha = 'a'.repeat(40)
const blob = createHash('sha1').update('blob 3\0abc').digest('hex')
const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

it('pins file reads to the inspected commit, retains resources, and never fetches an install script automatically', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ sha }))
    .mockResolvedValueOnce(json({ tree: [{ path: 'skills/design/SKILL.md', type: 'blob', mode: '100644', sha: blob, size: 3 }, { path: 'install.sh', type: 'blob', mode: '100755', sha: blob, size: 999 }] }))
    .mockResolvedValueOnce(new Response('abc'))
  const repo = await fetchSkillRepository('https://github.com/a/b.git', asFetch(fetcher))
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect((await repo.read(repo.files[0]!)).toString()).toBe('abc')
  expect(fetcher.mock.calls[2]![0]).toBe(`https://raw.githubusercontent.com/a/b/${sha}/skills/design/SKILL.md`)
  expect(fetcher.mock.calls[2]![1]).toMatchObject({ redirect: 'error' })
  await repo.read(repo.files[0]!)
  expect(fetcher).toHaveBeenCalledTimes(3)
  await repo.dispose()
})

it('tree URLs traverse the selected directory before fetching its recursive listing', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ sha }))
    .mockResolvedValueOnce(json({ tree: [{ path: 'skills', type: 'tree', sha: blob }] }))
    .mockResolvedValueOnce(json({ tree: [{ path: 'design/SKILL.md', type: 'blob', mode: '100644', sha: blob, size: 3 }] }))
  const repo = await fetchSkillRepository('https://github.com/a/b/tree/main/skills', asFetch(fetcher))
  expect(repo.files[0]!.path).toBe('skills/design/SKILL.md')
  expect(fetcher.mock.calls[2]![0]).toBe(`https://api.github.com/repos/a/b/git/trees/${blob}?recursive=1`)
})

it.each([403, 404, 429])('reports GitHub HTTP %s without installing anything', async status => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('denied', { status }))
  await expect(fetchSkillRepository('https://github.com/a/b', asFetch(fetcher))).rejects.toThrow(status === 404 ? '404' : '限制請求頻率')
})

it('rejects oversized files before downloading and refuses truncated repository listings', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ sha }))
    .mockResolvedValueOnce(json({ tree: [{ path: 'huge/SKILL.md', type: 'blob', mode: '100644', sha: blob, size: 3 * 1024 * 1024 }] }))
  const repo = await fetchSkillRepository('https://github.com/a/b', asFetch(fetcher))
  await expect(repo.read(repo.files[0]!)).rejects.toThrow('大小不支援')
  expect(fetcher).toHaveBeenCalledTimes(2)
  const truncated = vi.fn().mockResolvedValueOnce(json({ sha })).mockResolvedValueOnce(json({ truncated: true, tree: [] }))
  await expect(fetchSkillRepository('https://github.com/a/b', asFetch(truncated))).rejects.toThrow('檔案過多')
})

it('rejects streamed oversized responses even without Content-Length', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(6 * 1024 * 1024 + 1)))
  await expect(fetchSkillRepository('https://github.com/a/b', asFetch(fetcher))).rejects.toThrow('大小限制')
})

it('rejects file content that does not match the pinned Git blob hash', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ sha }))
    .mockResolvedValueOnce(json({ tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: blob, size: 3 }] }))
    .mockResolvedValueOnce(new Response('xyz'))
  const repo = await fetchSkillRepository('https://github.com/a/b', asFetch(fetcher))
  await expect(repo.read(repo.files[0]!)).rejects.toThrow('內容與版本不符')
})
