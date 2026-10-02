// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetQueueForTests } from '../src/renderer/read-queue.js'
import { PreviewPane } from '../src/renderer/components/PreviewPane.js'
import type { PreviewReadResult } from '../src/shared/ipc.js'
import { PreviewContext } from '../src/renderer/preview-context.js'

afterEach(() => {
  cleanup()
  resetQueueForTests()
})

const apiReturning = (result: PreviewReadResult) => ({ readPreview: async () => result })

it('文件內連結以文件目錄及來源專案開啟，不跟隨前景專案', async () => {
  const open = vi.fn()
  render(<PreviewContext.Provider value={open}>
    <PreviewPane api={apiReturning({ kind: 'markdown', text: '[下一份](../next.md:8)' })}
      source={{ kind: 'file', projectId: 'original-project', path: 'docs/reports/start.md' }} />
  </PreviewContext.Provider>)
  fireEvent.click(await screen.findByRole('link', { name: '下一份' }))
  expect(open).toHaveBeenCalledWith({ kind: 'file', path: 'docs/next.md', projectId: 'original-project', location: { line: 8 } })
})

describe('PreviewPane', () => {
  it('截圖直接畫', () => {
    const { container } = render(
      <PreviewPane api={apiReturning({ kind: 'rejected', message: 'x' })} source={{ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', key: 'k' }} />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('檔案是 Markdown 就排版', async () => {
    render(<PreviewPane api={apiReturning({ kind: 'markdown', text: '# 標題一' })} source={{ kind: 'file', projectId: 'p1', path: 'a.md' }} />)
    expect((await screen.findByRole('heading', { name: '標題一' })).tagName).toBe('H1')
  })

  it('檔案是圖片就畫圖', async () => {
    const { container } = render(
      <PreviewPane api={apiReturning({ kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' })} source={{ kind: 'file', projectId: 'p1', path: 'a.png' }} />
    )
    await screen.findByRole('img')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
  })

  it('被拒絕就顯示原因', async () => {
    render(<PreviewPane api={apiReturning({ kind: 'rejected', message: '不在專案資料夾內' })} source={{ kind: 'file', projectId: 'p1', path: '/etc/x.md' }} />)
    expect(await screen.findByText('不在專案資料夾內')).not.toBeNull()
  })
})

it('切換來源後忽略舊讀取結果,卸載後忽略失敗', async () => {
  let resolveOld: ((r: PreviewReadResult) => void) | undefined
  let rejectNew: ((reason: unknown) => void) | undefined
  const api = { readPreview: ({ path }: { path: string }) => new Promise<PreviewReadResult>((resolve, reject) => {
    if (path === 'old.md') resolveOld = resolve
    else rejectNew = reject
  }) }
  const { rerender, unmount } = render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: 'old.md' }} />)
  expect(screen.getByText('讀取中…')).not.toBeNull()
  rerender(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: 'new.md' }} />)
  await act(async () => { resolveOld?.({ kind: 'markdown', text: '# 過期' }) })
  expect(screen.queryByRole('heading')).toBeNull()
  unmount()
  await act(async () => { rejectNew?.(new Error('已卸載')) })
})

it.each([new Error('讀取失敗'), '讀取失敗'])('讀取 promise 失敗顯示原因: %s', async (error) => {
  const api = { readPreview: async (): Promise<PreviewReadResult> => { throw error } }
  render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: 'a.md' }} />)
  expect(await screen.findByText('讀取失敗')).not.toBeNull()
})

it('Markdown 裡的相對路徑圖片經 readPreview 讀,以檔案所在目錄為基準;遠端圖片照舊', async () => {
  const asked: string[] = []
  const api = {
    readPreview: async ({ path }: { projectId: string; path: string }): Promise<PreviewReadResult> => {
      asked.push(path)
      if (path.endsWith('.md')) return { kind: 'markdown', text: '![本機](img/a.png)\n\n![遠端](https://example.com/b.png)' }
      return { kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' }
    },
  }
  const { container } = render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: '/p/docs/r.md' }} />)
  await screen.findByRole('img', { name: '本機' })
  await vi.waitFor(() => { expect(container.querySelector('img[alt="本機"]')?.getAttribute('src')).toBe('data:image/png;base64,AQID') })
  expect(container.querySelector('img[alt="遠端"]')?.getAttribute('src')).toBe('https://example.com/b.png')
  expect(asked).toEqual(['/p/docs/r.md', '/p/docs/img/a.png'])
})

it('相對路徑圖片讀不到就顯示原因', async () => {
  const api = {
    readPreview: async ({ path }: { projectId: string; path: string }): Promise<PreviewReadResult> =>
      path.endsWith('.md') ? { kind: 'markdown', text: '![x](../../etc/a.png)' } : { kind: 'rejected', message: '不在專案資料夾內' },
  }
  render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p1', path: 'a.md' }} />)
  expect(await screen.findByText('(圖片讀取失敗:不在專案資料夾內)')).not.toBeNull()
})

it('遠端與 data 圖片直接顯示，連結仍過濾危險 scheme', async () => {
  const readPreview = vi.fn(async (): Promise<PreviewReadResult> => ({
    kind: 'markdown', text: '![](data:image/png;base64,AQID)\n\n![cdn](//cdn.example.com/a.png)\n\n[x](javascript:alert%281%29)',
  }))
  const { container } = render(<PreviewPane api={{ readPreview }} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  await screen.findByRole('img', { name: 'cdn' })
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
  expect(container.querySelector('a')?.getAttribute('href')).toBe('')
  expect(readPreview).toHaveBeenCalledTimes(1)
})

it.each([new Error('boom'), 'boom', { kind: 'markdown', text: 'x' }])('圖片失敗與非圖片結果有原因: %s', async (result) => {
  const api = { readPreview: async ({ path }: { path: string }): Promise<PreviewReadResult> => {
    if (path === 'a.md') return { kind: 'markdown', text: '![x](a.png)' }
    if (typeof result === 'object' && 'kind' in result) return { kind: 'markdown', text: result.text }
    throw result
  } }
  render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  expect(await screen.findByText(`(圖片讀取失敗:${typeof result === 'object' && 'kind' in result ? '不是圖片' : 'boom'})`)).not.toBeNull()
})

it.each([true, false])('圖片讀取中顯示替代文字，卸載後忽略完成: %s', async (reject) => {
  let finish: (() => void) | undefined
  const api = { readPreview: async ({ path }: { path: string }): Promise<PreviewReadResult> => {
    if (path === 'a.md') return { kind: 'markdown', text: reject ? '![替代](a.png)' : '![](a.png)' }
    return new Promise((resolve, fail) => {
      finish = () => reject ? fail(new Error('過期')) : resolve({ kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' })
    })
  } }
  const { unmount } = render(<PreviewPane api={api} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  expect(await screen.findByText(reject ? '替代' : '圖片')).not.toBeNull()
  unmount()
  await act(async () => { finish?.() })
})

it('預覽被上限拒絕後可重試同一檔案', async () => {
  const readPreview = vi.fn<() => Promise<PreviewReadResult>>()
    .mockResolvedValueOnce({ kind: 'rejected', message: '同時開啟的預覽太多,請稍後再試' })
    .mockResolvedValueOnce({ kind: 'markdown', text: '# 重試成功' })
  render(<PreviewPane api={{ readPreview }} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  expect(await screen.findByText('同時開啟的預覽太多,請稍後再試')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  expect(await screen.findByRole('heading', { name: '重試成功' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
  expect(readPreview.mock.calls).toEqual([[{ projectId: 'p', path: 'a.md' }], [{ projectId: 'p', path: 'a.md' }]])
})

it('Markdown 圖片被上限拒絕後可重試同一圖片', async () => {
  const readPreview = vi.fn<() => Promise<PreviewReadResult>>()
    .mockResolvedValueOnce({ kind: 'markdown', text: '![本機](img/a.png)' })
    .mockResolvedValueOnce({ kind: 'rejected', message: '同時開啟的預覽太多,請稍後再試' })
    .mockResolvedValueOnce({ kind: 'image', mimeType: 'image/png', dataBase64: 'AQID' })
  render(<PreviewPane api={{ readPreview }} source={{ kind: 'file', projectId: 'p', path: 'docs/a.md' }} />)
  fireEvent.click(await screen.findByRole('button', { name: '重試' }))
  expect((await screen.findByRole('img', { name: '本機' })).getAttribute('src')).toBe('data:image/png;base64,AQID')
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
  expect(readPreview.mock.calls).toEqual([
    [{ projectId: 'p', path: 'docs/a.md' }],
    [{ projectId: 'p', path: 'docs/img/a.png' }],
    [{ projectId: 'p', path: 'docs/img/a.png' }],
  ])
})

it('目錄依渲染後標題建立，重複章節與中文 anchor 在預覽內定位', async () => {
  const text = '# 標題\n\n[到第二節](#報表-1)\n\n## 報表\n\n第一節\n\n## 報表\n\n第二節'
  const { container } = render(<PreviewPane api={apiReturning({ kind: 'markdown', text })} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  const link = await screen.findByRole('link', { name: '到第二節' })
  expect(container.querySelectorAll('[data-preview-anchor]')).toHaveLength(3)
  expect(fireEvent.click(link)).toBe(false)
  expect(document.activeElement?.textContent).toBe('報表')
  expect(document.activeElement?.getAttribute('data-preview-anchor')).toBe('報表-1')
  const details = container.querySelector('details')!
  details.open = true
  fireEvent.click(screen.getAllByRole('button', { name: '報表' })[0]!)
  expect(document.activeElement?.getAttribute('data-preview-anchor')).toBe('報表')
  expect(details.open).toBe(false)
})

it('外部行號定位到程式碼所在區塊，缺失章節明示且不改應用網址', async () => {
  const text = '# 開頭\n\n```ts\nconst answer = 42\n```\n\n[缺失](#missing)'
  const { container } = render(<PreviewPane api={apiReturning({ kind: 'markdown', text })}
    source={{ kind: 'file', projectId: 'p', path: 'a.md', location: { line: 4 } }} />)
  await screen.findByText('已定位至第 4 行所在段落')
  expect(container.querySelector('pre')?.classList.contains('preview-target')).toBe(true)
  const before = window.location.href
  fireEvent.click(screen.getByRole('link', { name: '缺失' }))
  expect(screen.getByRole('status').textContent).toBe('找不到章節：missing')
  expect(window.location.href).toBe(before)
})

it('搜尋跨行內標記與高亮程式碼，結果可循環切換與清除', async () => {
  const text = '# 報告\n\n完整**報表**已更新，完整報表。\n\n```js\nconst value = 42\n```'
  const { container } = render(<PreviewPane api={apiReturning({ kind: 'markdown', text })} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  fireEvent.click(await screen.findByRole('button', { name: '搜尋' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '完整報表' } })
  await screen.findByText('1 / 2')
  expect(container.querySelectorAll('mark.preview-current-match')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '下一個搜尋結果' }))
  expect(screen.getByText('2 / 2')).not.toBeNull()
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
  expect(screen.getByText('1 / 2')).not.toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'const value' } })
  await screen.findByText('1 / 1')
  expect(container.querySelector('pre mark')).not.toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '[.*' } })
  await screen.findByText('0 / 0')
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(container.querySelector('mark')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '搜尋' }))
  fireEvent.keyDown(document.activeElement!, { key: 'f', ctrlKey: true })
  expect(screen.getByRole('searchbox')).toBe(document.activeElement)
})

it('手動重新整理可讀到更新內容，失敗後仍能重試', async () => {
  const readPreview = vi.fn<() => Promise<PreviewReadResult>>()
    .mockResolvedValueOnce({ kind: 'markdown', text: '# 原版本' })
    .mockResolvedValueOnce({ kind: 'rejected', message: '暫時無法讀取' })
    .mockResolvedValueOnce({ kind: 'markdown', text: '# 新版本' })
  render(<PreviewPane api={{ readPreview }} source={{ kind: 'file', projectId: 'p', path: 'a.md' }} />)
  await screen.findByRole('heading', { name: '原版本' })
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
  await screen.findByText('暫時無法讀取')
  fireEvent.click(screen.getByRole('button', { name: '重試' }))
  await screen.findByRole('heading', { name: '新版本' })
  expect(screen.queryByRole('heading', { name: '原版本' })).toBeNull()
  expect(readPreview).toHaveBeenCalledTimes(3)
})
