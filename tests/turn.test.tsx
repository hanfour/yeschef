// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Conversation } from '../src/renderer/components/Conversation.js'
import type { Block, ConversationView } from '../src/shared/fold.js'
import type { TranslatePayload, TranslateResult } from '../src/shared/translate.js'
const translate = vi.fn<(p: TranslatePayload) => Promise<TranslateResult>>()
const viewOf = (blocks: readonly Block[]): ConversationView => ({ turns: [{ role: 'assistant', blocks }], ended: false })
afterEach(() => { cleanup(); localStorage.clear(); translate.mockReset() })
it('完成的 text block 才有翻譯按鈕,原文保留且譯文在下方', async () => {
  const { container, rerender } = render(<Conversation historical={false} translate={translate} view={viewOf([{ kind: 'text', markdown: 'Hello', complete: false }])} />)
  expect(screen.queryByText('譯')).toBeNull()
  rerender(<Conversation historical={false} translate={translate} view={viewOf([{ kind: 'text', markdown: 'Hello', complete: true }])} />)
  translate.mockResolvedValue({ kind: 'ok', text: '你好' })
  fireEvent.click(screen.getByText('譯')); fireEvent.click(screen.getByText('繁體中文'))
  await screen.findByText('你好')
  expect(screen.getByText('Hello')).not.toBeNull()
  expect(container.querySelector('.markdown-block')?.nextElementSibling?.className).toBe('translate-bar')
})
it('沒有 translate 時整個控制列不畫', () => {
  const { container } = render(<Conversation historical view={viewOf([{ kind: 'text', markdown: 'Hello', complete: true }])} />)
  expect(container.querySelector('.translate-bar')).toBeNull()
})
it('thinking、tool、compact-summary、compact-boundary、unknown 沒有翻譯按鈕', () => {
  const { container } = render(<Conversation historical={false} translate={translate} view={viewOf([
    { kind: 'thinking', text: '想', complete: true },
    { kind: 'tool', id: 't', name: 'Bash', input: {}, status: 'done' },
    { kind: 'compact-summary', text: '摘要' },
    { kind: 'compact-boundary', trigger: 'auto', preTokens: 100 },
    { kind: 'unknown', raw: {} },
  ])} />)
  expect(container.querySelector('.translate-bar')).toBeNull()
})
it('translate 換成不同的 function 時 Turn 要重畫', async () => {
  const view = viewOf([{ kind: 'text', markdown: 'Hello', complete: true }])
  const next = vi.fn<(p: TranslatePayload) => Promise<TranslateResult>>().mockResolvedValue({ kind: 'ok', text: '新函式' })
  const { rerender } = render(<Conversation historical={false} view={view} translate={translate} />)
  rerender(<Conversation historical={false} view={view} translate={next} />)
  fireEvent.click(screen.getByText('譯')); fireEvent.click(screen.getByText('English'))
  await screen.findByText('新函式')
  expect(next).toHaveBeenCalledWith({ text: 'Hello', target: 'en' })
  expect(translate).not.toHaveBeenCalled()
})
it('相同 translate 參考與區塊內容保留 Turn memo', () => {
  const block: Block = { kind: 'tool', id: 't', name: 'Bash', input: {}, status: 'done' }
  const renderToolOverride = vi.fn(() => undefined)
  const { rerender } = render(<Conversation historical={false} view={viewOf([block])} translate={translate} renderToolOverride={renderToolOverride} />)
  const calls = renderToolOverride.mock.calls.length
  rerender(<Conversation historical={false} view={viewOf([{ ...block }])} translate={translate} renderToolOverride={renderToolOverride} />)
  expect(renderToolOverride).toHaveBeenCalledTimes(calls)
})
it('原文改變時清除舊譯文快取', async () => {
  translate.mockResolvedValueOnce({ kind: 'ok', text: '你好' }).mockResolvedValueOnce({ kind: 'ok', text: '再見' })
  const { rerender } = render(<Conversation historical={false} translate={translate} view={viewOf([{ kind: 'text', markdown: 'Hello', complete: true }])} />)
  fireEvent.click(screen.getByText('譯')); fireEvent.click(screen.getByText('繁體中文'))
  await screen.findByText('你好')
  rerender(<Conversation historical={false} translate={translate} view={viewOf([{ kind: 'text', markdown: 'Bye', complete: true }])} />)
  expect(screen.queryByText('你好')).toBeNull()
  fireEvent.click(screen.getByText('譯→繁體中文'))
  await screen.findByText('再見')
  expect(translate).toHaveBeenLastCalledWith({ text: 'Bye', target: 'zh-Hant' })
})

it('使用者自己的訊息沒有翻譯按鈕', () => {
  const text = { kind: 'text', markdown: 'Hello', complete: true } as const
  const view = (role: 'user' | 'assistant'): ConversationView => ({ turns: [{ role, blocks: [text] }], ended: false })
  const { container, rerender } = render(<Conversation historical={false} translate={translate} view={view('user')} />)
  expect(container.querySelector('.translate-bar')).toBeNull()
  rerender(<Conversation historical={false} translate={translate} view={view('assistant')} />)
  expect(container.querySelector('.translate-bar')).not.toBeNull()
})
