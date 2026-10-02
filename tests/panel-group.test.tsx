// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PanelGroup, type PanelGroupProps } from '../src/renderer/components/PanelGroup.js'
import type { RectPayload } from '../src/shared/ipc.js'

/** jsdom 沒有 ResizeObserver;記下 callback,測試自己觸發。 */
let observed: (() => void) | undefined
class FakeResizeObserver {
  constructor(cb: () => void) { observed = cb }
  observe(): void {}
  disconnect(): void { observed = undefined }
}

let rect = { x: 800, y: 30, width: 800, height: 840 }
function stubRect(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observed = undefined
  rect = { x: 800, y: 30, width: 800, height: 840 }
})

function setup(collapsed: boolean, browser: Partial<PanelGroupProps['browser']> = {}) {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  stubRect()
  const sent: (RectPayload | null)[] = []
  const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: (r: RectPayload | null) => { sent.push(r) }, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
  const run = vi.fn(() => Promise.resolve({ ok: true as const }))
  const utils = render(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={collapsed}
    browser={{ conversationId: null, state: undefined, lastUrl: null, run, ...browser }} />)
  return { sent, run, ...utils }
}

describe('PanelGroup', () => {
  it('展開時回報內容區的矩形', () => {
    const { sent, container } = setup(false)
    expect(sent).toEqual([{ x: 800, y: 30, width: 800, height: 840 }])
    expect(container.querySelector('[role="tab"]')?.textContent).toBe('瀏覽器')
  })

  it('收起時回報 null,整個區塊藏起來', () => {
    const { sent, container } = setup(true)
    expect(sent).toEqual([null])
    expect(container.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
  })

  it('大小沒變就不重送,變了才送', () => {
    const { sent } = setup(false)
    act(() => { observed?.() })
    expect(sent).toHaveLength(1)
    rect = { x: 700, y: 30, width: 900, height: 840 }
    act(() => { observed?.() })
    expect(sent).toEqual([{ x: 800, y: 30, width: 800, height: 840 }, { x: 700, y: 30, width: 900, height: 840 }])
  })

  it('視窗改大小也會重新量', () => {
    const { sent } = setup(false)
    rect = { x: 600, y: 30, width: 600, height: 700 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(sent.at(-1)).toEqual({ x: 600, y: 30, width: 600, height: 700 })
  })

  it('從展開切到收起送 null,再展開送回矩形', () => {
    const { sent, rerender } = setup(false)
    const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: (r: RectPayload | null) => { sent.push(r) }, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
    rerender(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={true}
      browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
    expect(sent.at(-1)).toBeNull()
    rerender(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
      browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
    expect(sent.at(-1)).toEqual({ x: 800, y: 30, width: 800, height: 840 })
  })

  it('卸載時送 null,瀏覽器不會留在畫面上', () => {
    const { sent, unmount } = setup(false)
    unmount()
    expect(sent.at(-1)).toBeNull()
  })

  it('瀏覽器分頁在前景時有網址列;回報的矩形是網址列下方的內容區', () => {
    setup(false)
    expect(screen.getByRole('textbox', { name: '網址' })).toBeTruthy()
  })

  it('預覽分頁在前景時沒有網址列', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubRect()
    const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: () => {}, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
    render(<PanelGroup dragging={false} activeId="p1" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
      previews={[{ id: 'p1', title: 'a.md', revision: 0, source: { kind: 'file', path: '/a.md', projectId: 'p1' } }]}
      browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
    expect(screen.queryByRole('textbox', { name: '網址' })).toBeNull()
  })

  it('沒有 session 且有 lastUrl:顯示「上次停在」,按開啟送 navigate', () => {
    const { run } = setup(false, { lastUrl: 'https://last.test/' })
    expect(screen.getByText('https://last.test/')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '開啟' }))
    expect(run).toHaveBeenCalledWith({ kind: 'navigate', url: 'https://last.test/' })
  })

  it('有 session 時不顯示空狀態', () => {
    setup(false, { state: { conversationId: 'c1', url: 'https://a.test/', title: '', loading: false, canGoBack: false, canGoForward: false } })
    expect(screen.queryByText('這個對話還沒開過瀏覽器')).toBeNull()
  })

  it('切到另一個同樣沒有瀏覽器的對話:編輯到一半的內容與錯誤都不帶過去', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubRect()
    const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: () => {}, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
    const run = vi.fn(() => Promise.resolve({ ok: false as const, message: '這不是網址' }))
    const { rerender } = render(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
      browser={{ conversationId: 'c1', state: undefined, lastUrl: 'https://one.test/', run }} />)
    const input = screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByRole('alert')
    rerender(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
      browser={{ conversationId: 'c2', state: undefined, lastUrl: 'https://two.test/', run }} />)
    expect((screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement).value).toBe('https://two.test/')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it('StrictMode 清理後重新掛載仍回報矩形', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  stubRect()
  const sent: (RectPayload | null)[] = []
  const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: (r: RectPayload | null) => { sent.push(r) }, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
  render(<StrictMode><PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
    browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} /></StrictMode>)
  expect(sent).toEqual([rect, null, rect])
})

it('邊界是小數時右邊界不會超出去', () => {
  rect = { x: 800.5, y: 30, width: 799.5, height: 840 }
  const { sent } = setup(false)
  // 右邊界 1600,不是 801 + 800 = 1601
  expect(sent).toEqual([{ x: 801, y: 30, width: 799, height: 840 }])
})

it('預覽分頁在前景時瀏覽器藏起來,切回瀏覽器再回報矩形', () => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  stubRect()
  const sent: (RectPayload | null)[] = []
  const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: (r: RectPayload | null) => { sent.push(r) }, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
  const previews = [{ id: 'a', title: 'a.md', source: { kind: 'file' as const, projectId: 'p1', path: 'a.md' }, revision: 0 }]
  const props = { api, collapsed: false, previews, onActivate: () => {}, onClose: () => {},
    browser: { conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true as const }) } }
  const { rerender } = render(<PanelGroup dragging={false} {...props} activeId="a" />)
  expect(sent.at(-1)).toBeNull()
  rerender(<PanelGroup dragging={false} {...props} activeId="browser" />)
  expect(sent.at(-1)).toEqual({ x: 800, y: 30, width: 800, height: 840 })
})

it('預覽分頁有關閉按鈕,按了呼叫 onClose', () => {
  const closed: string[] = []
  const previews = [{ id: 'a', title: 'a.md', source: { kind: 'file' as const, projectId: 'p1', path: 'a.md' }, revision: 0 }]
  const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: () => {}, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
  render(<PanelGroup dragging={false} api={api} collapsed={false} previews={previews} activeId="a" onActivate={() => {}} onClose={(id) => { closed.push(id) }}
    browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
  fireEvent.click(screen.getByRole('button', { name: '關閉預覽' }))
  expect(closed).toEqual(['a'])
})

// 審查追加:合併列的出現條件在 PanelGroup 這層決定(diff 分頁的那個對話有沒有 worktree),
// 以前只在 DevelopmentDiff 自己的測試裡驗過。
describe('diff 分頁的合併列', () => {
  const previews = [{ id: 'd1', title: '開發變更', revision: 0, source: { kind: 'diff' as const, conversationId: 'tab-a' } }]
  const api = {
    conversationTools: async () => ({ kind: 'error' as const, message: 'test' }),
    setBrowserBounds: () => {},
    readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }),
    worktreeMerge: async () => ({
      kind: 'status' as const, branch: 'task', target: 'main', ahead: 1, dirty: false, conflictPending: false,
      message: '分支 task → main,領先 1 個 commit',
    }),
  }
  const projectWith = (worktreePath?: string) => [{
    id: 'p1', name: 'alpha', rootPath: '/p/alpha', activeTabId: 'tab-a', lastActiveAt: 0,
    tabs: [{ id: 'tab-a', label: '對話', contentType: 'conversation' as const, ...(worktreePath === undefined ? {} : { worktreePath }) }],
  }] as unknown as PanelGroupProps['projects']

  const mount = (worktreePath?: string): void => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubRect()
    render(<PanelGroup dragging={false} api={api} collapsed={false} previews={previews} activeId="d1"
      onActivate={() => {}} onClose={() => {}} projects={projectWith(worktreePath)}
      browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
  }

  it('分頁有 worktreePath 時合併列出現', async () => {
    mount('/p/alpha/.worktrees/task')
    expect(await screen.findByRole('region', { name: 'worktree 合併' })).toBeTruthy()
  })

  it('分頁沒有 worktreePath 時合併列不出現', async () => {
    mount()
    await screen.findByRole('region', { name: '開發變更 diff' })
    expect(screen.queryByRole('region', { name: 'worktree 合併' })).toBeNull()
  })
})

it('拖曳中瀏覽器回報 null', () => {
  const { sent, rerender } = setup(false)
  const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: (r: RectPayload | null) => { sent.push(r) }, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
  rerender(<PanelGroup dragging={true} api={api} collapsed={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}}
    browser={{ conversationId: null, state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
  expect(sent.at(-1)).toBeNull()
})
