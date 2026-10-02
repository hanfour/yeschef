import type { CdpConnection } from './group-acceptance-cdp.js'
import { SHORT_TIMEOUT_MS, waitFor, type RuntimeContext } from './group-acceptance-runtime.js'
import { readProjectState, type GroupDomRow, type ProjectTab } from './group-acceptance-state.js'

export interface ConversationSnapshot {
  readonly mode: string
  readonly turns: readonly { readonly role: string; readonly text: string }[]
}

export async function click(page: CdpConnection, selector: string): Promise<void> {
  const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!(el instanceof HTMLElement)) return false; el.click(); return true })()`
  if (!(await page.evaluate<boolean>(expression))) throw new Error(`DOM 找不到可點擊項目 ${selector}`)
}

export async function typeAndEnter(page: CdpConnection, selector: string, text: string): Promise<void> {
  const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!(el instanceof HTMLTextAreaElement) || el.disabled) return false; el.scrollIntoView({ block: 'center' }); el.click(); el.focus(); return document.activeElement === el })()`
  if (!(await page.evaluate<boolean>(expression))) throw new Error(`DOM 輸入框不可用 ${selector}`)
  await page.send('Input.insertText', { text })
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

export async function visibleGroup(page: CdpConnection): Promise<boolean> {
  return page.evaluate<boolean>('Boolean(document.querySelector(".group-pane") && !document.querySelector(".pane-slot-group[hidden]"))')
}

export async function ensureGroupVisible(page: CdpConnection): Promise<void> {
  if (await visibleGroup(page)) return
  await click(page, '.tab[role="tab"][data-provider="group"]')
  await waitFor('群組 pane 掛載', SHORT_TIMEOUT_MS, async () => {
    const visible = await visibleGroup(page)
    return { done: visible, value: undefined, detail: `groupPane=${visible}` }
  })
}

export async function groupDomSnapshot(page: CdpConnection): Promise<readonly GroupDomRow[]> {
  return page.evaluate<readonly GroupDomRow[]>(`Array.from(document.querySelectorAll('.group-message')).map(row => {
    const from = row.querySelector('.group-from')?.textContent?.trim() ?? '';
    const text = row.querySelector('.group-text')?.textContent?.trim() ?? '';
    return { from, text };
  })`)
}

export async function conversationSnapshot(page: CdpConnection): Promise<ConversationSnapshot> {
  return page.evaluate<ConversationSnapshot>(`(() => {
    const pane = document.querySelector('.pane-slot-conversation:not([hidden]) .conversation-workspace');
    const mode = pane?.querySelector('.conversation-mode')?.textContent?.trim() ?? '';
    const turns = Array.from(pane?.querySelectorAll('.turn') ?? []).map(turn => ({
      role: turn.classList.contains('turn-assistant') ? 'assistant' : turn.classList.contains('turn-user') ? 'user' : 'other',
      text: turn.textContent?.trim() ?? '',
    }));
    return { mode, turns };
  })()`)
}

export async function activeProjectState(ctx: RuntimeContext): Promise<{ activeTabId?: string; tabs: readonly ProjectTab[] } | undefined> {
  const state = await readProjectState(ctx)
  const project = state?.projects.find((candidate) => candidate.id === ctx.projectId)
  if (project === undefined) return undefined
  const active = project.tabs.reduce<ProjectTab | undefined>(
    (latest, tab) => latest === undefined || tab.lastFocusedAt > latest.lastFocusedAt ? tab : latest,
    undefined,
  )
  return { activeTabId: active?.id, tabs: project.tabs }
}

export async function jumpTo(page: CdpConnection, label: string): Promise<void> {
  const selector = `.group-jump[aria-label=${JSON.stringify(`跳到 ${label} 的分頁`)}]`
  await waitFor(`訊息旁的跳轉按鈕「${label}」`, SHORT_TIMEOUT_MS, async () => {
    const found = await page.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    return { done: found, value: undefined, detail: `label=${label} button=${found}` }
  })
  await click(page, selector)
}

export async function returnToGroup(page: CdpConnection): Promise<void> {
  await click(page, '.tab[role="tab"][data-provider="group"]')
  await waitFor('回到群組 pane', SHORT_TIMEOUT_MS, async () => {
    const visible = await visibleGroup(page)
    return { done: visible, value: undefined, detail: `groupPane=${visible}` }
  })
}

export async function clickThreadFilter(page: CdpConnection, title: string): Promise<void> {
  const expression = `(() => { const button = Array.from(document.querySelectorAll('.group-thread')).find(el => el.getAttribute('title') === ${JSON.stringify(title)}); if (!(button instanceof HTMLElement)) return false; button.click(); return true })()`
  await waitFor('thread filter button 存在', SHORT_TIMEOUT_MS, async () => {
    const exists = await page.evaluate<boolean>(`Array.from(document.querySelectorAll('.group-thread')).some(el => el.getAttribute('title') === ${JSON.stringify(title)})`)
    return { done: exists, value: undefined, detail: `title=${title} exists=${exists}` }
  })
  if (!(await page.evaluate<boolean>(expression))) throw new Error(`群組找不到 thread 篩選鈕 title=${title}`)
  await waitFor('目標 thread 篩選按鈕 aria-pressed=true', SHORT_TIMEOUT_MS, async () => {
    const state = await page.evaluate<boolean>(`Array.from(document.querySelectorAll('.group-thread')).some(el => el.getAttribute('title') === ${JSON.stringify(title)} && el.getAttribute('aria-pressed') === 'true')`)
    return { done: state, value: undefined, detail: `title=${title} pressed=${state}` }
  })
}
