// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TranslateBar } from '../src/renderer/components/TranslateBar.js'
import type { TranslatePayload, TranslateResult } from '../src/shared/translate.js'

const key = 'yeschef.translate.lastLanguage'
const translate = vi.fn<(p: TranslatePayload) => Promise<TranslateResult>>()
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); translate.mockReset() })
function start() { fireEvent.click(screen.getByText('譯')) }
function choose(label: string) { fireEvent.click(screen.getByRole('button', { name: label })) }

it('沒有上次語言時,按譯會展開五種語言', () => {
  render(<TranslateBar text="Hello" translate={translate} />)
  expect(screen.getByText('譯').getAttribute('aria-label')).toContain('Hello')
  start()
  for (const label of ['繁體中文', 'English', '日本語', '한국어', '简体中文']) {
    expect(screen.getByRole('button', { name: label }).textContent).toBe(label)
  }
  start()
  expect(screen.queryByText('日本語')).toBeNull()
})

it('選了語言之後呼叫 translate,期間顯示翻譯中,完成後顯示譯文', async () => {
  let finish: (r: TranslateResult) => void = () => { throw new Error('尚未開始') }
  translate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); choose('繁體中文')
  expect(translate).toHaveBeenCalledWith({ text: 'Hello', target: 'zh-Hant' })
  expect(screen.getByRole('status').textContent).toBe('翻譯中 0 秒')
  expect(screen.getByText('譯→繁體中文').hasAttribute('disabled')).toBe(true)
  finish({ kind: 'ok', text: '你好' })
  expect(await screen.findByText('你好')).not.toBeNull()
})

it('同一段再翻第二種語言,兩種譯文都在,各自可以收起且快取不重打', async () => {
  translate.mockResolvedValueOnce({ kind: 'ok', text: '你好' }).mockResolvedValueOnce({ kind: 'ok', text: 'こんにちは' })
  const { container } = render(<TranslateBar text="Hello" translate={translate} />)
  start(); choose('繁體中文'); await screen.findByText('你好')
  fireEvent.click(screen.getByText('⌄')); choose('日本語'); await screen.findByText('こんにちは')
  const results = container.querySelectorAll<HTMLElement>('.translate-result')
  expect(results).toHaveLength(2)
  for (const result of results) fireEvent.click(within(result).getByText('收起'))
  expect(screen.queryByText('你好')).toBeNull()
  expect(screen.queryByText('こんにちは')).toBeNull()
  fireEvent.click(screen.getByText('譯→日本語'))
  expect(screen.getByText('こんにちは')).not.toBeNull()
  fireEvent.click(screen.getByText('⌄')); choose('繁體中文')
  expect(screen.getByText('你好')).not.toBeNull()
  expect(translate).toHaveBeenCalledTimes(2)
})

it.each(['rejected', 'throw'] as const)('失敗 %s 顯示訊息與重試', async (kind) => {
  if (kind === 'rejected') translate.mockResolvedValueOnce({ kind: 'rejected', message: '翻譯逾時，請重試' })
  else translate.mockRejectedValueOnce(new Error('IPC disconnected'))
  translate.mockResolvedValueOnce({ kind: 'ok', text: '你好' })
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); choose('繁體中文')
  expect((await screen.findByRole('alert')).textContent).toContain(kind === 'rejected' ? '翻譯逾時，請重試' : '翻譯失敗，請重試')
  fireEvent.click(screen.getByText('重試'))
  await screen.findByText('你好')
  expect(translate).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('記住上次的語言,下次按鈕直接顯示成 譯→English 並一鍵翻譯', async () => {
  translate.mockResolvedValue({ kind: 'ok', text: 'Hi' })
  const first = render(<TranslateBar text="你好" translate={translate} />)
  start(); choose('English'); await screen.findByText('Hi')
  expect(localStorage.getItem(key)).toBe('en')
  first.unmount()
  render(<TranslateBar text="哈囉" translate={translate} />)
  fireEvent.click(screen.getByText('譯→English')); await screen.findByText('Hi')
  expect(translate).toHaveBeenLastCalledWith({ text: '哈囉', target: 'en' })
})

it('localStorage 讀取丟例外時不會壞掉', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied') })
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); expect(screen.getByText('English')).not.toBeNull()
})
it('localStorage 寫入丟例外時仍能翻譯', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  translate.mockResolvedValue({ kind: 'ok', text: 'Hi' })
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); choose('English'); await screen.findByText('Hi')
})
it('無效的上次語言視為沒有', () => {
  localStorage.setItem(key, 'invalid')
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); expect(screen.getByText('English')).not.toBeNull()
})

it('第一次使用時「譯」本身就是展開清單的按鈕,要有 aria-expanded 與 aria-controls', () => {
  render(<TranslateBar text="Hello" translate={translate} />)
  const button = screen.getByText('譯')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  const listId = button.getAttribute('aria-controls')
  expect(listId).toBeTruthy()
  start()
  expect(screen.getByText('譯').getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(listId ?? '')?.className).toBe('translate-languages')
})

it('翻譯中的秒數會跳動,而且秒數那段是 aria-hidden(不逐秒播報)', async () => {
  vi.useFakeTimers()
  translate.mockImplementation(() => new Promise(() => { /* 永遠不 resolve */ }))
  render(<TranslateBar text="Hello" translate={translate} />)
  start(); choose('繁體中文')
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('翻譯中 0 秒')
  expect(status.querySelector('[aria-hidden="true"]')?.textContent).toBe(' 0 秒')
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByRole('status').textContent).toBe('翻譯中 3 秒')
  vi.useRealTimers()
})
