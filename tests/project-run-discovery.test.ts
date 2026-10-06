import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverProjectRunCandidates } from '../src/main/project-run/discovery.js'

const roots: string[] = []
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-discovery-'))
  roots.push(root)
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const SERVER = "parser.add_argument('--port', type=int, default=6062)\n"

describe('discoverProjectRunCandidates', () => {
  it('讀取 Python 入口檔，預設埠空著時沿用', async () => {
    const root = await project({ 'server.py': SERVER })
    await mkdir(join(root, '.venv'))
    const candidates = await discoverProjectRunCandidates(root, { isFree: async () => true, findFreePort: async () => 50123 })
    expect(candidates[0]).toMatchObject({ command: '.venv/bin/python server.py --port {port}', port: 6062, portStrategy: 'placeholder' })
  })

  it('可替換連接埠的預設埠被佔用時改用空著的埠', async () => {
    const root = await project({ 'server.py': SERVER })
    const checked: number[] = []
    const candidates = await discoverProjectRunCandidates(root, {
      isFree: async port => { checked.push(port); return port !== 6062 },
      findFreePort: async () => 50123,
    })
    expect(candidates[0]).toMatchObject({ port: 50123, portStrategy: 'placeholder' })
    expect(checked).toEqual([6062])
  })

  it('固定連接埠的候選不替換，讓使用者看到原本的埠', async () => {
    const root = await project({ 'app.py': 'app.run(port=5050)\n' })
    const candidates = await discoverProjectRunCandidates(root, { isFree: async () => false, findFreePort: async () => 50123 })
    expect(candidates[0]?.port).toBe(5050)
  })

  it('沒有提供連接埠檢查時只回傳偵測結果', async () => {
    const root = await project({ 'server.py': SERVER })
    expect((await discoverProjectRunCandidates(root))[0]?.port).toBe(6062)
  })
})
