import { describe, expect, it, vi } from 'vitest'
import { createPreviewReader, readPreview, TOO_MANY, type PreviewReadDeps } from '../src/main/preview-read.js'
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MARKDOWN_MAX_BYTES, fileNameOf, imageMimeOf, previewKindOf } from '../src/shared/preview.js'

/** 假的檔案系統:realpath 照表轉,沒列的就原樣;檔案內容與大小照表給。 */
function fakeDeps(over: Partial<PreviewReadDeps> = {}): PreviewReadDeps {
  const links: Record<string, string> = { '/proj/link-out.md': '/home/me/.ssh/notes.md', '/proj/pic.png': '/proj/a.md' }
  const files: Record<string, Buffer> = {
    '/proj/a.md': Buffer.from('# 標題'),
    '/proj/..notes.md': Buffer.from('點點開頭'),
    '/proj/shot.png': Buffer.from([1, 2, 3]),
    '/home/me/.ssh/notes.md': Buffer.from('秘密'),
  }
  return {
    rootPathOf: (id) => (id === 'p1' ? '/proj' : undefined),
    realpath: async (p) => {
      const target = links[p] ?? p
      if (files[target] === undefined && target !== '/proj') throw new Error('ENOENT')
      return target
    },
    stat: async (p) => ({ size: files[p]?.length ?? 0, isFile: true }),
    readFile: async (p) => {
      const data = files[p]
      if (data === undefined) throw new Error('ENOENT')
      return data
    },
    ...over,
  }
}

describe('previewKindOf', () => {
  it('圖片與 Markdown,大小寫不分', () => {
    expect(previewKindOf('/a/B.PNG')).toBe('image')
    expect(previewKindOf('x.jpeg')).toBe('image')
    expect(previewKindOf('README.md')).toBe('markdown')
    expect(previewKindOf('notes.markdown')).toBe('markdown')
    expect(previewKindOf('run.sh')).toBeUndefined()
    expect(previewKindOf('noext')).toBeUndefined()
  })
})

describe('readPreview', () => {
  it('讀專案裡的 Markdown', async () => {
    expect(await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/a.md' })).toEqual({ kind: 'markdown', text: '# 標題' })
  })

  it('相對路徑以專案根目錄為基準', async () => {
    expect(await readPreview(fakeDeps(), { projectId: 'p1', path: 'a.md' })).toEqual({ kind: 'markdown', text: '# 標題' })
  })

  it('圖片回 base64 與 mime type', async () => {
    expect(await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/shot.png' })).toEqual({ kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' })
  })

  it('找不到專案、副檔名不收、檔案不存在都回 rejected', async () => {
    expect((await readPreview(fakeDeps(), { projectId: 'nope', path: '/proj/a.md' })).kind).toBe('rejected')
    expect((await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/run.sh' })).kind).toBe('rejected')
    expect((await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/missing.md' })).kind).toBe('rejected')
  })

  it('.. 跳出專案資料夾不收', async () => {
    const r = await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/../home/me/.ssh/notes.md' })
    expect(r).toEqual({ kind: 'rejected', message: '不在專案資料夾內' })
  })

  it('符號連結指到專案外面不收', async () => {
    const r = await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/link-out.md' })
    expect(r).toEqual({ kind: 'rejected', message: '不在專案資料夾內' })
  })

  it('超過大小上限不讀內容', async () => {
    let read = false
    const deps = fakeDeps({ stat: async () => ({ size: PREVIEW_MARKDOWN_MAX_BYTES + 1, isFile: true }), readFile: async () => { read = true; return Buffer.from('') } })
    const r = await readPreview(deps, { projectId: 'p1', path: '/proj/a.md' })
    expect(r.kind).toBe('rejected')
    expect(read).toBe(false)
  })
})


describe('預覽邊界與檢查順序', () => {
  it('所有允許的圖片副檔名與跨平台檔名', () => {
    for (const [ext, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]) {
      expect(previewKindOf(`a.${ext?.toUpperCase()}`)).toBe('image')
      expect(imageMimeOf(`a.${ext}`)).toBe(mime)
    }
    for (const ext of ['constructor', '__proto__']) {
      expect(previewKindOf(`a.${ext}`)).toBeUndefined()
      expect(imageMimeOf(`a.${ext}`)).toBeUndefined()
    }
    expect(previewKindOf('.md')).toBeUndefined()
    expect(previewKindOf('folder.md/noext')).toBeUndefined()
    expect(previewKindOf('a.')).toBeUndefined()
    expect(fileNameOf('C:\\proj\\a.md')).toBe('a.md')
    expect(fileNameOf('/proj/a.md')).toBe('a.md')
    expect(fileNameOf('')).toBe('')
  })

  it('找不到專案及不允許的副檔名都不碰檔案系統', async () => {
    const deps = fakeDeps({ realpath: async () => { throw new Error('不應呼叫') } })
    expect(await readPreview(deps, { projectId: 'nope', path: 'a.exe' })).toEqual({ kind: 'rejected', message: '找不到專案 nope' })
    expect(await readPreview(deps, { projectId: 'p1', path: 'missing.exe' })).toEqual({ kind: 'rejected', message: '只能預覽圖片與 Markdown' })
  })

  it('根目錄也取 realpath,後續只讀解析後的路徑', async () => {
    const deps = fakeDeps({
      rootPathOf: () => '/alias',
      realpath: async (p) => p === '/alias' ? '/proj' : '/proj/a.md',
    })
    expect(await readPreview(deps, { projectId: 'p1', path: 'a.md' })).toEqual({ kind: 'markdown', text: '# 標題' })
  })

  it('根目錄本身與相同字首的鄰居都不收,也不查大小', async () => {
    for (const target of ['/proj', '/proj-other/a.md']) {
      const deps = fakeDeps({
        realpath: async (p) => p === '/proj' ? '/proj' : target,
        stat: async () => { throw new Error('不應查大小') },
      })
      expect(await readPreview(deps, { projectId: 'p1', path: 'a.md' })).toEqual({ kind: 'rejected', message: '不在專案資料夾內' })
    }
  })

  it('兩種大小剛好上限可讀,超過上限不讀', async () => {
    expect(PREVIEW_IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(PREVIEW_MARKDOWN_MAX_BYTES).toBe(2 * 1024 * 1024)
    for (const [path, limit] of [['shot.png', PREVIEW_IMAGE_MAX_BYTES], ['a.md', PREVIEW_MARKDOWN_MAX_BYTES]] as const) {
      expect((await readPreview(fakeDeps({ stat: async () => ({ size: limit, isFile: true }) }), { projectId: 'p1', path })).kind).not.toBe('rejected')
      const deps = fakeDeps({ stat: async () => ({ size: limit + 1, isFile: true }), readFile: async () => { throw new Error('不應讀內容') } })
      expect(await readPreview(deps, { projectId: 'p1', path })).toEqual({ kind: 'rejected', message: `檔案太大(${String(limit + 1)} bytes,上限 ${String(limit)})` })
    }
  })

  it('圖片連結的實際檔案沒有副檔名,不收也不讀', async () => {
    let read = false
    const deps = fakeDeps({ realpath: async (p) => p === '/proj' ? '/proj' : '/proj/data', stat: async () => ({ size: 0, isFile: true }), readFile: async () => { read = true; return Buffer.from('') } })
    expect(await readPreview(deps, { projectId: 'p1', path: 'a.png' })).toEqual({ kind: 'rejected', message: '只能預覽圖片與 Markdown' })
    expect(read).toBe(false)
  })

  it('專案根目錄下名字以 .. 開頭的檔案是合法的', async () => {
    expect(await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/..notes.md' })).toEqual({ kind: 'markdown', text: '點點開頭' })
  })

  it('符號連結的名字是圖片、實際是 Markdown,不收', async () => {
    const r = await readPreview(fakeDeps(), { projectId: 'p1', path: '/proj/pic.png' })
    expect(r).toEqual({ kind: 'rejected', message: '只能預覽圖片與 Markdown' })
  })
})

describe('同時讀取的上限', () => {
  it('超過上限的請求直接拒絕,前面的讀完之後又能讀', async () => {
    const releases: (() => void)[] = []
    const deps = fakeDeps({
      readFile: () => new Promise<Buffer>((resolveRead) => { releases.push(() => { resolveRead(Buffer.from('# x')) }) }),
    })
    const read = createPreviewReader(deps, 2)
    const first = read({ projectId: 'p1', path: 'a.md' })
    const second = read({ projectId: 'p1', path: 'a.md' })
    expect(await read({ projectId: 'p1', path: 'a.md' })).toEqual({ kind: 'rejected', message: TOO_MANY })
    // 等前兩個都走到 readFile 再放行
    await vi.waitFor(() => { expect(releases).toHaveLength(2) })
    releases.forEach((release) => { release() })
    expect((await first).kind).toBe('markdown')
    expect((await second).kind).toBe('markdown')
    const third = read({ projectId: 'p1', path: 'a.md' })
    await vi.waitFor(() => { expect(releases).toHaveLength(3) })
    releases[2]?.()
    expect((await third).kind).toBe('markdown')
  })

  it('讀取失敗也會釋放名額', async () => {
    const deps = fakeDeps({ readFile: async () => { throw new Error('EIO') } })
    const read = createPreviewReader(deps, 1)
    await expect(read({ projectId: 'p1', path: 'a.md' })).rejects.toThrow('EIO')
    await expect(read({ projectId: 'p1', path: 'a.md' })).rejects.toThrow('EIO')
  })
})

describe('不是一般檔案', () => {
  it('具名管道之類的不讀,免得 readFile 永遠卡住', async () => {
    let read = false
    const deps = fakeDeps({ stat: async () => ({ size: 0, isFile: false }), readFile: async () => { read = true; return Buffer.from('') } })
    expect(await readPreview(deps, { projectId: 'p1', path: 'a.md' })).toEqual({ kind: 'rejected', message: '不是一般檔案' })
    expect(read).toBe(false)
  })
})

