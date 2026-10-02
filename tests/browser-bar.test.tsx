// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserBar } from '../src/renderer/components/BrowserBar.js'
import type { BrowserCommand, BrowserCommandResult, BrowserStatePayload } from '../src/shared/browser-ipc.js'

afterEach(cleanup)

const STATE: BrowserStatePayload = { conversationId: 'c1', url: 'https://a.test/', title: 'A', loading: false, canGoBack: true, canGoForward: false }

function setup(state: BrowserStatePayload | undefined, result: BrowserCommandResult = { ok: true }, fallbackUrl = '') {
  const run = vi.fn((_c: BrowserCommand) => Promise.resolve(result))
  const utils = render(<BrowserBar state={state} fallbackUrl={fallbackUrl} run={run} />)
  const input = screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement
  return { run, input, ...utils }
}

describe('BrowserBar', () => {
  it('顯示目前網址;上一頁可按,下一頁不可按', () => {
    const { input } = setup(STATE)
    expect(input.value).toBe('https://a.test/')
    expect((screen.getByRole('button', { name: '上一頁' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '下一頁' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('沒有 session:預填 fallbackUrl,三個導覽按鈕都不可按', () => {
    const { input } = setup(undefined, { ok: true }, 'https://last.test/')
    expect(input.value).toBe('https://last.test/')
    for (const name of ['上一頁', '下一頁', '重新整理']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('按 Enter 送 navigate', async () => {
    const { run, input } = setup(STATE)
    fireEvent.change(input, { target: { value: 'localhost:3000' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => { expect(run).toHaveBeenCalledWith({ kind: 'navigate', url: 'localhost:3000' }) })
  })

  it('被拒絕時在輸入框下方顯示原因;再打字就清掉', async () => {
    const { input } = setup(STATE, { ok: false, message: '這不是網址' })
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect((await screen.findByRole('alert')).textContent).toBe('這不是網址')
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('按 Esc 還原成目前網址', () => {
    const { input } = setup(STATE)
    fireEvent.change(input, { target: { value: '打到一半' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('https://a.test/')
  })

  it('沒在編輯時,網址跟著狀態更新;編輯中不被蓋掉', () => {
    const { input, rerender, run } = setup(STATE)
    rerender(<BrowserBar state={{ ...STATE, url: 'https://a.test/next' }} fallbackUrl="" run={run} />)
    expect(input.value).toBe('https://a.test/next')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '打到一半' } })
    rerender(<BrowserBar state={{ ...STATE, url: 'https://a.test/third' }} fallbackUrl="" run={run} />)
    expect(input.value).toBe('打到一半')
  })

  it('換了對話就丟掉編輯中的內容與錯誤', async () => {
    // 換對話由 PanelGroup 用 key 讓 BrowserBar 整個重掛,不是靠 props 變化偵測(controller 裁決:
    // 移除 owner useEffect 的特例,兩個都「沒有 session」的對話不會漏比對)。
    const run = vi.fn((_c: BrowserCommand) => Promise.resolve<BrowserCommandResult>({ ok: false, message: '這不是網址' }))
    const { rerender } = render(<BrowserBar key="c1" state={STATE} fallbackUrl="" run={run} />)
    const input = screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x y' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByRole('alert')
    rerender(<BrowserBar key="c2" state={{ ...STATE, conversationId: 'c2', url: 'https://b.test/' }} fallbackUrl="" run={run} />)
    expect((screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement).value).toBe('https://b.test/')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('載入中時重新整理變成停止', () => {
    const { run } = setup({ ...STATE, loading: true })
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(run).toHaveBeenCalledWith({ kind: 'stop' })
  })
})
