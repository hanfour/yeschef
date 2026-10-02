import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAttachments } from '../src/main/attachments.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function rig(names: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-attachments-')); roots.push(root)
  const paths: string[] = []
  for (const [name, content] of Object.entries(names)) { const path = join(root, name); await writeFile(path, content); paths.push(path) }
  const dir = join(root, 'stored')
  return { root, dir, service: createAttachments(dir, async () => paths) }
}
it('文件採副本與不透明 ID；不容許其他對話使用，送出後不可重複消費', async () => {
  const r = await rig({ 'notes.md': '# Notes', 'report.pdf': '%PDF-1.4 synthetic' })
  const picked = await r.service.pick('c')
  expect(picked.map(p => p.kind)).toEqual(['text', 'file'])
  expect(picked[0]).not.toHaveProperty('path')
  expect(() => r.service.prepare('other', [picked[0]!.id])).toThrow('不屬於')
  await writeFile(join(r.root, 'notes.md'), 'changed')
  const input = r.service.prepare('c', picked.map(p => p.id))
  expect(input[0]?.text).toBe('# Notes')
  expect(await readFile(input[1]!.path, 'utf8')).toContain('%PDF')
  r.service.sent(picked.map(p => p.id))
  expect(() => r.service.prepare('c', [picked[0]!.id])).toThrow('已失效')
})
it('照片產生預覽及原生圖片 payload；移除只刪複本', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64')
  const r = await rig({ 'photo.png': png }); const [meta] = await r.service.pick('c')
  expect(meta?.thumbnail).toMatch(/^data:image\/png;base64,/)
  expect(r.service.prepare('c', [meta!.id])[0]?.data).toBe(png.toString('base64'))
  await r.service.remove('c', meta!.id)
  expect(await readdir(r.dir)).toEqual([]); expect(await readFile(join(r.root, 'photo.png'))).toEqual(png)
})
it('批次中的假圖片或非法 UTF-8 失敗時不留下半套附件', async () => {
  for (const invalid of ([{ 'fake.png': 'not-an-image' }, { 'bad.txt': Buffer.from([0xc3, 0x28]) }] as Record<string, string | Buffer>[])) {
    const r = await rig({ 'valid.md': 'hello', ...invalid }); await expect(r.service.pick('c')).rejects.toThrow()
    expect(await readdir(r.dir)).toEqual([])
  }
})
it('每則訊息最多八份附件，取消選檔不增加附件', async () => {
  const r = await rig(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i}.txt`, 'hi'])))
  await expect(r.service.pick('c')).rejects.toThrow('最多 8')
  expect(await createAttachments(r.dir, async () => []).pick('c')).toEqual([])
})

it('provider 歷史保留附件名稱而不把整份文件內容灌進對話畫面', async () => {
  const { attachmentPrompt, displayAttachmentPrompt } = await import('../src/shared/conversation-tools.js')
  const prompt = attachmentPrompt('檢查這份文件', [{ name: 'long.md', kind: 'text', path: '/copy/long.md', mime: 'application/octet-stream', text: 'long private document' }])
  expect(prompt).toContain('long private document')
  expect(displayAttachmentPrompt(prompt)).toBe('檢查這份文件\n\n附件：long.md')
  expect(displayAttachmentPrompt('使用者的一般文字')).toBe('使用者的一般文字')
})
