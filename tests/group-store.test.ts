import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GROUP_FILE_MAX_BYTES, createGroupStore, type GroupStore } from '../src/main/group/store.js'
import type { GroupMessage } from '../src/shared/group.js'

const roots: string[] = []
const stores: GroupStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const message = (id: string, over: Partial<GroupMessage> = {}): GroupMessage => ({
  id, projectId: 'p1', threadId: 't1', at: 1_700_000_000_000, from: { kind: 'user' },
  kind: 'text', text: `訊息 ${id}`, mentions: [], ...over,
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-group-'))
  roots.push(root)
  const errors: Error[] = []
  const store = createGroupStore(root, (error) => errors.push(error))
  stores.push(store)
  return { root, errors, store, path: join(root, 'p1.ndjson') }
}

describe('群組訊息的 NDJSON 落地', () => {
  it('追加之後讀得回來,順序是舊到新', async () => {
    const r = await rig()
    await r.store.append(message('a'))
    await r.store.append(message('b'))
    expect((await r.store.read('p1')).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('沒有檔案時回空陣列,不記錯誤', async () => {
    const r = await rig()
    expect(await r.store.read('missing')).toEqual([])
    expect(r.errors).toHaveLength(0)
  })

  it('壞行被跳過,只記一次錯誤', async () => {
    const r = await rig()
    await r.store.append(message('a'))
    await writeFile(r.path, `${JSON.stringify(message('a'))}\n不是 JSON\n{"id":"缺欄位"}\n${JSON.stringify(message('b'))}\n`)
    expect((await r.store.read('p1')).map((m) => m.id)).toEqual(['a', 'b'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.message).toContain('2')
  })

  it('超過 2000 則只回最後 2000', async () => {
    const r = await rig()
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify(message(`m${i}`))).join('\n')
    await writeFile(r.path, `${lines}\n`)
    const read = await r.store.read('p1')
    expect(read).toHaveLength(2000)
    expect(read[0]?.id).toBe('m100')
    expect(read.at(-1)?.id).toBe('m2099')
  })

  it('超過 5 MB 讀取時裁掉前半,留下的舊訊息還在,新訊息接得上', async () => {
    const r = await rig()
    const padded = (id: string) => JSON.stringify(message(id, { text: 'x'.repeat(3000) }))
    const count = Math.ceil(GROUP_FILE_MAX_BYTES / 3100) + 20
    await writeFile(r.path, `${Array.from({ length: count }, (_, i) => padded(`m${i}`)).join('\n')}\n`)
    const read = await r.store.read('p1')
    expect(read.at(-1)?.id).toBe(`m${count - 1}`)
    expect(read.some((m) => m.id === `m${count - 5}`)).toBe(true)
    expect(read.some((m) => m.id === 'm0')).toBe(false)
    expect((await readFile(r.path, 'utf8')).length).toBeLessThan(GROUP_FILE_MAX_BYTES)
    expect(r.errors).toHaveLength(1)
    await r.store.append(message('after'))
    expect((await r.store.read('p1')).at(-1)?.id).toBe('after')
  })

  it('同一個超過 5 MB 的檔案併發讀取時只裁一次', async () => {
    const r = await rig()
    const padded = (id: string) => JSON.stringify(message(id, { text: 'x'.repeat(3000) }))
    const count = Math.ceil(GROUP_FILE_MAX_BYTES / 3100) + 20
    await writeFile(r.path, `${Array.from({ length: count }, (_, i) => padded(`m${i}`)).join('\n')}\n`)
    await Promise.all([r.store.read('p1'), r.store.read('p1')])
    expect(r.errors).toHaveLength(1)
  })

  it('同時追加兩則不會交錯,兩則都完整', async () => {
    const r = await rig()
    await Promise.all([r.store.append(message('a')), r.store.append(message('b'))])
    const text = await readFile(r.path, 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(2)
    expect((await r.store.read('p1')).map((m) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('追加失敗往外拋,呼叫端自己決定怎麼處理', async () => {
    const r = await rig()
    await expect(r.store.append(message('a', { projectId: '../escape' }))).rejects.toThrow('專案代號')
  })

  it('dispose 之後等得到還沒寫完的追加', async () => {
    const r = await rig()
    r.store.append(message('a'))
    await r.store.dispose()
    expect((await readFile(r.path, 'utf8')).trimEnd().split('\n')).toEqual([JSON.stringify(message('a'))])
  })
})
