import { describe, expect, it } from 'vitest'
import { previewLocationOfLink, previewPathOfLink, resolveImageSrc } from '../src/shared/preview.js'

it('保留章節與正整數行號，不把查詢參數当行號', () => {
  expect(previewLocationOfLink('docs/a.md:12:3')).toEqual({ line: 12 })
  expect(previewLocationOfLink('docs/a.md#L20-L25')).toEqual({ line: 20 })
  expect(previewLocationOfLink('#%E5%A0%B1%E8%A1%A8')).toEqual({ anchor: '報表' })
  expect(previewLocationOfLink('docs/a.md?line=12')).toBeUndefined()
  expect(previewLocationOfLink('docs/a.md:0')).toBeUndefined()
  expect(previewLocationOfLink('docs/a.md:99999999999999999')).toBeUndefined()
})

it('本機預覽連結處理行號、編碼、相對文件路徑並拒絕URL', () => {
  expect(previewPathOfLink('README.md:12')).toBe('README.md')
  expect(previewPathOfLink('../my%20report.md#L2', 'docs/notes/start.md')).toBe('docs/my report.md')
  expect(previewPathOfLink('literal%2520.md', 'docs/start.md')).toBe('docs/literal%20.md')
  expect(previewPathOfLink('/project/a.png:3')).toBe('/project/a.png')
  expect(previewPathOfLink('../../outside.md', 'docs/start.md')).toBe('../outside.md')
  for (const href of ['https://a/report.md', '//a/report.md', '%2F%2Fa/report.md', 'javascript:report.md', 'file:///a.md', 'data:text/plain,a.md', '#heading', '?report.md', 'code.ts', 'a%00.md']) {
    expect(previewPathOfLink(href)).toBeUndefined()
  }
})

describe('resolveImageSrc', () => {
  it('遠端與 data URL 不處理', () => {
    for (const src of ['https://img.shields.io/x.svg', 'http://a/b.png', 'data:image/png;base64,AAAA', '//cdn.example.com/a.png', 'mailto:x@y']) {
      expect(resolveImageSrc('/p/README.md', src)).toBeUndefined()
    }
  })

  it('相對路徑以 Markdown 檔所在目錄為基準', () => {
    expect(resolveImageSrc('/p/docs/a.md', 'shot.png')).toBe('/p/docs/shot.png')
    expect(resolveImageSrc('/p/docs/a.md', './img/shot.png')).toBe('/p/docs/img/shot.png')
    expect(resolveImageSrc('/p/docs/a.md', '../shot.png')).toBe('/p/shot.png')
  })

  it('Markdown 檔是相對於專案根目錄的路徑也能合併', () => {
    expect(resolveImageSrc('README.md', 'docs/shot.png')).toBe('docs/shot.png')
    expect(resolveImageSrc('docs/a.md', '../shot.png')).toBe('shot.png')
    expect(resolveImageSrc('a.md', '../x.png')).toBe('../x.png')
  })

  it('絕對路徑原樣', () => {
    expect(resolveImageSrc('/p/a.md', '/Users/me/p/shot.png')).toBe('/Users/me/p/shot.png')
  })

  it('去掉 query 與 hash,解開 %20', () => {
    expect(resolveImageSrc('/p/a.md', 'my%20shot.png?raw=1#top')).toBe('/p/my shot.png')
    expect(resolveImageSrc('/p/a.md', 'bad%zz.png')).toBe('/p/bad%zz.png')
  })
})
