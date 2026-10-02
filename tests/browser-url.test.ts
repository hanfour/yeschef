import { describe, expect, it } from 'vitest'
import { normalizeBrowserInput } from '../src/shared/browser-url.js'

describe('網址列輸入正規化', () => {
  it('空白回 empty', () => {
    expect(normalizeBrowserInput('   ')).toEqual({ kind: 'empty' })
  })

  it('已有協定的原樣往下,只去頭尾空白', () => {
    expect(normalizeBrowserInput(' https://a.test/x ')).toEqual({ kind: 'url', url: 'https://a.test/x' })
    expect(normalizeBrowserInput('file:///tmp/a.html')).toEqual({ kind: 'url', url: 'file:///tmp/a.html' })
  })

  it('沒有 // 的已知協定也原樣往下,交給白名單擋', () => {
    expect(normalizeBrowserInput('javascript:alert(1)')).toEqual({ kind: 'url', url: 'javascript:alert(1)' })
    expect(normalizeBrowserInput('about:blank')).toEqual({ kind: 'url', url: 'about:blank' })
  })

  it('本機位址補 http://', () => {
    expect(normalizeBrowserInput('localhost:3000/path')).toEqual({ kind: 'url', url: 'http://localhost:3000/path' })
    expect(normalizeBrowserInput('127.0.0.1:5173')).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173' })
    expect(normalizeBrowserInput('[::1]:8080')).toEqual({ kind: 'url', url: 'http://[::1]:8080' })
    expect(normalizeBrowserInput('localhost')).toEqual({ kind: 'url', url: 'http://localhost' })
  })

  it('含點且沒有空白的補 https://,帶 port 也一樣', () => {
    expect(normalizeBrowserInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(normalizeBrowserInput('example.com:8080/a')).toEqual({ kind: 'url', url: 'https://example.com:8080/a' })
  })

  it('其餘不是網址', () => {
    expect(normalizeBrowserInput('hello world')).toEqual({ kind: 'not-url' })
    expect(normalizeBrowserInput('測試機首頁')).toEqual({ kind: 'not-url' })
    expect(normalizeBrowserInput('a. b')).toEqual({ kind: 'not-url' })
  })

  it('localhostx 不算本機位址', () => {
    expect(normalizeBrowserInput('localhostx')).toEqual({ kind: 'not-url' })
  })
})
