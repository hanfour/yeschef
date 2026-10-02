// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Recents, type RecentsProps } from '../src/renderer/components/Recents.js'
import { formatElapsed, formatRelativeTime } from '../src/renderer/components/relative-time.js'
import type { SessionSummary } from '../src/shared/ipc.js'
import type { SessionLink, ThreadEntry } from '../src/shared/projects.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const THREE: readonly SessionSummary[] = [
  { sessionId: 's-1', summary: '第一場', lastModified: NOW - 2 * MINUTE, gitBranch: 'main' },
  { sessionId: 's-2', summary: '第二場', lastModified: NOW - 3 * HOUR, customTitle: '自訂標題' },
  { sessionId: 's-3', summary: '第三場', lastModified: NOW - 5 * DAY },
]

function renderRecents(over: Partial<RecentsProps> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const onOpen = vi.fn()
  const onStartNew = vi.fn()
  const utils = render(
    <Recents sessions={THREE} onOpen={onOpen} onStartNew={onStartNew} {...over} />
  )
  return { ...utils, onOpen, onStartNew }
}

describe('formatRelativeTime', () => {
  it.each([
    ['一分鐘內是剛剛', NOW - 30_000, '剛剛'],
    ['未滿一小時用分鐘', NOW - 59 * MINUTE, '59 分鐘前'],
    ['未滿一天用小時', NOW - 23 * HOUR, '23 小時前'],
    ['未滿三十天用天', NOW - 29 * DAY, '29 天前'],
    ['超過三十天用日期', Date.UTC(2026, 0, 15), '2026-01-15'],
  ])('%s', (_label, ms, expected) => {
    expect(formatRelativeTime(ms, NOW)).toBe(expected)
  })

  it('剛好一分鐘就進位成 1 分鐘前，不再是剛剛', () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1 分鐘前')
  })

  it('時鐘偏差導致的未來時間顯示剛剛，不顯示負數', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe('剛剛')
  })

  it('不是有限數字時給明確文案，不產生 Invalid Date', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('時間不明')
  })
})

describe('formatElapsed', () => {
  it.each([
    ['0 毫秒仍不到一分鐘', 0, '不到 1 分鐘'],
    ['59999 毫秒仍不到一分鐘', 59_999, '不到 1 分鐘'],
    ['滿一分鐘進位成 1 分鐘', 60_000, '1 分鐘'],
    ['一分鐘多 1 毫秒仍是 1 分鐘', 60_001, '1 分鐘'],
    ['接近兩分鐘但未滿仍是 1 分鐘', 119_999, '1 分鐘'],
    ['滿兩分鐘進位成 2 分鐘', 120_000, '2 分鐘'],
    ['負數視為不到 1 分鐘', -500_000, '不到 1 分鐘'],
    ['非有限數視為不到 1 分鐘', Number.NaN, '不到 1 分鐘'],
  ])('%s', (_label, ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})

describe('Recents 清單', () => {
  it('每一筆都畫出來，customTitle 優先於 summary', () => {
    const { container } = renderRecents()
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題', '第三場'])
  })

  it('顯示相對時間', () => {
    const { container } = renderRecents()
    const times = [...container.querySelectorAll('time')].map((n) => n.textContent)
    expect(times).toEqual(['2 分鐘前', '3 小時前', '5 天前'])
  })

  it('有 gitBranch 才顯示分支', () => {
    const { container } = renderRecents()
    const branches = [...container.querySelectorAll('.recents-branch')].map((n) => n.textContent)
    expect(branches).toEqual(['main'])
  })

  it('current 那一筆才有高亮，其餘沒有', () => {
    const { container } = renderRecents({ current: 's-2' })
    const items = [...container.querySelectorAll('.recents-item')]
    expect(items.map((n) => n.classList.contains('is-current'))).toEqual([false, true, false])
    expect(items.map((n) => n.getAttribute('aria-current'))).toEqual([null, 'true', null])
  })

  it('沒有 current 時三筆都不高亮', () => {
    const { container } = renderRecents()
    expect(container.querySelectorAll('.is-current')).toHaveLength(0)
  })
})

describe('Recents 互動', () => {
  // 點第二筆而不是第一筆：實作若退化成永遠傳第一筆的 sessionId，這條會紅。
  it('點清單第二筆時帶著那一筆的 sessionId 呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    const items = container.querySelectorAll('.recents-item')
    fireEvent.click(items[1] as Element)
    expect(onOpen.mock.calls).toEqual([['s-2']])
    expect(onStartNew).not.toHaveBeenCalled()
  })

  it('點第三筆帶第三筆的 sessionId', () => {
    const { container, onOpen } = renderRecents()
    fireEvent.click(container.querySelectorAll('.recents-item')[2] as Element)
    expect(onOpen.mock.calls).toEqual([['s-3']])
  })

  it('新對話按鈕呼叫 onStartNew，不呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('Recents 的空清單與錯誤', () => {
  it('沒有歷史對話時給明確文案', () => {
    const { container } = renderRecents({ sessions: [] })
    expect(container.querySelector('.recents-empty')?.textContent).toBe('還沒有歷史對話')
    expect(container.querySelector('.recents-error')).toBeNull()
  })

  it('載入失敗時顯示錯誤，且不顯示「還沒有歷史對話」', () => {
    const { container } = renderRecents({ sessions: [], error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')?.textContent).toBe('讀取歷史對話清單失敗')
    expect(container.querySelector('.recents-empty')).toBeNull()
  })

  it('錯誤與舊清單同時存在時，兩者都看得到', () => {
    const { container } = renderRecents({ error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')).not.toBeNull()
    expect(container.querySelectorAll('.recents-item')).toHaveLength(3)
  })

  it('新對話按鈕在錯誤狀態下仍然可用', () => {
    const { container, onStartNew } = renderRecents({ sessions: [], error: '壞了' })
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
  })
})

const link = (sessionId: string): SessionLink => ({
  linkId: sessionId,
  provider: 'claude',
  sessionId,
  transcriptPath: `/t/${sessionId}.jsonl`,
  parentLinkId: null,
  startedAt: 0,
  endedAt: null,
  endReason: null,
  models: [],
})
/** s-3 → s-2 這一條 thread,s-2 是現行。 */
const ONE_THREAD: readonly ThreadEntry[] = [
  { id: 'th', sessions: [link('s-3'), link('s-2')], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 },
]

describe('Recents 依 thread 分組', () => {
  it('同一條 thread 收成一列,尾端有「+N 筆較早」', () => {
    const { container } = renderRecents({ threads: ONE_THREAD })
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題'])
    expect(container.querySelector('.recents-expand')?.textContent).toBe('+1 筆較早')
  })

  it('按「+N 筆較早」展開較早的 session,再按一次收合', () => {
    const { container } = renderRecents({ threads: ONE_THREAD })
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題', '第三場'])
    expect(container.querySelector('.recents-expand')?.textContent).toBe('收合')
    expect(container.querySelector('.recents-expand')?.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(container.querySelector('.recents-expand') as Element)
    expect(container.querySelectorAll('.recents-title')).toHaveLength(2)
  })

  it('展開後點較早的那一筆,onOpen 帶它的 sessionId', () => {
    const { container, onOpen } = renderRecents({ threads: ONE_THREAD })
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    fireEvent.click(container.querySelector('.recents-rest .recents-item') as Element)
    expect(onOpen.mock.calls).toEqual([['s-3']])
  })

  it('current 在較早那一筆時,head 不高亮,展開後那一筆才高亮', () => {
    const { container } = renderRecents({ threads: ONE_THREAD, current: 's-3' })
    expect(container.querySelectorAll('.is-current')).toHaveLength(0)
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    expect(container.querySelector('.is-current .recents-title')?.textContent).toBe('第三場')
  })
})

describe('Recents 的範圍切換', () => {
  it('沒給 onScopeChange 就不畫切換鈕', () => {
    const { container } = renderRecents()
    expect(container.querySelector('.recents-scope')).toBeNull()
  })

  it('本專案／全部 兩顆鈕以 aria-pressed 標示目前範圍,按另一顆呼叫 onScopeChange', () => {
    const onScopeChange = vi.fn()
    const { getByRole } = renderRecents({ scope: 'project', onScopeChange })
    expect(getByRole('button', { name: '本專案' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(getByRole('button', { name: '全部' }))
    expect(onScopeChange.mock.calls).toEqual([['all']])
  })

  it('範圍是全部時每一列顯示 cwd;本專案時不顯示', () => {
    const withCwd = THREE.map((s) => ({ ...s, cwd: `/Users/x/${s.sessionId}` }))
    const all = renderRecents({ sessions: withCwd, scope: 'all', onScopeChange: vi.fn() })
    expect([...all.container.querySelectorAll('.recents-cwd')].map((n) => n.textContent)).toEqual([
      '/Users/x/s-1',
      '/Users/x/s-2',
      '/Users/x/s-3',
    ])
    cleanup()
    const project = renderRecents({ sessions: withCwd, scope: 'project', onScopeChange: vi.fn() })
    expect(project.container.querySelectorAll('.recents-cwd')).toHaveLength(0)
  })
})

it('搜尋歷史標題與分支，清除後恢復原清單', () => {
  const { container, getByRole, getByText } = renderRecents()
  const search = getByRole('searchbox', { name: '搜尋歷史對話' })
  fireEvent.change(search, { target: { value: '自訂' } })
  expect([...container.querySelectorAll('.recents-title')].map(n => n.textContent)).toEqual(['自訂標題'])
  fireEvent.change(search, { target: { value: 'MAIN' } })
  expect([...container.querySelectorAll('.recents-title')].map(n => n.textContent)).toEqual(['第一場'])
  fireEvent.change(search, { target: { value: '不存在' } })
  expect(getByText('找不到符合的對話')).not.toBeNull()
  fireEvent.change(search, { target: { value: '' } })
  expect(container.querySelectorAll('.recents-item')).toHaveLength(3)
})
