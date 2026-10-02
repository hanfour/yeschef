import { describe, expect, it } from 'vitest'
import { BROWSER_TAB_ID, closePreview, INITIAL_TABS, openPreview, type PreviewSource } from '../src/renderer/previews.js'

const shot = (key: string): PreviewSource => ({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', key })
const file = (path: string): PreviewSource => ({ kind: 'file', projectId: 'p1', path })

describe('預覽分頁狀態', () => {
  it('一開始只有瀏覽器,而且在前景', () => {
    expect(INITIAL_TABS).toEqual({ previews: [], activeId: BROWSER_TAB_ID })
  })

  it('開一個預覽會加在最後並切過去,標題照來源', () => {
    const s = openPreview(openPreview(INITIAL_TABS, shot('t1:0'), 'a'), file('/p/docs/README.md'), 'b')
    expect(s.previews.map((t) => [t.id, t.title])).toEqual([['a', '截圖'], ['b', 'README.md']])
    expect(s.activeId).toBe('b')
  })

  it('同一個來源不重開,只切過去並加 revision(再按一次等於重新整理)', () => {
    const s1 = openPreview(openPreview(INITIAL_TABS, file('/p/a.md'), 'a'), shot('t1:0'), 'b')
    const s2 = openPreview(s1, file('/p/a.md'), 'c')
    expect(s2.previews).toHaveLength(2)
    expect(s2.activeId).toBe('a')
    expect(s2.previews.map((t) => t.revision)).toEqual([1, 0])
  })

  it('關前景的預覽,前景改成左邊那個;左邊沒有就回瀏覽器', () => {
    const s = openPreview(openPreview(INITIAL_TABS, file('/p/a.md'), 'a'), file('/p/b.md'), 'b')
    const s1 = closePreview(s, 'b')
    expect(s1.activeId).toBe('a')
    expect(closePreview(s1, 'a')).toEqual({ previews: [], activeId: BROWSER_TAB_ID })
  })

  it('關背景的預覽不動前景', () => {
    const s = openPreview(openPreview(INITIAL_TABS, file('/p/a.md'), 'a'), file('/p/b.md'), 'b')
    expect(closePreview(s, 'a').activeId).toBe('b')
  })

  it('同份文件不同定位重用分頁並更新目的地', () => {
    const first = openPreview(INITIAL_TABS, { kind: 'file', projectId: 'p', path: 'a.md', location: { line: 2 } }, 'a')
    const next = openPreview(first, { kind: 'file', projectId: 'p', path: 'a.md', location: { anchor: '報表' } }, 'b')
    expect(next.previews).toHaveLength(1)
    expect(next.previews[0]?.source).toMatchObject({ location: { anchor: '報表' } })
    expect(next.previews[0]?.revision).toBe(1)
  })
})

it('截圖依 key 去重,不同專案的同一路徑各自開啟', () => {
  const s = openPreview(INITIAL_TABS, shot('k'), 'a')
  const again = openPreview(s, shot('k'), 'b')
  expect(again.previews.map((t) => [t.id, t.revision])).toEqual([['a', 1]])
  expect(again.activeId).toBe('a')
  const files = openPreview(s, file('a.md'), 'b')
  const next = openPreview(files, { kind: 'file', projectId: 'p2', path: 'a.md' }, 'c')
  expect(next.previews).toHaveLength(3)
  expect(files.previews).toHaveLength(2)
  expect(closePreview(next, 'missing')).toEqual(next)
})
