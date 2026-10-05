/** 兩種外觀各截一組 renderer 的圖（規格 §6.2）。先 npm run build。 */
import { app, BaseWindow, WebContentsView, nativeTheme } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
declare const __dirname: string

const OUT = join(__dirname, 'ui')
const RENDERER = join(__dirname, '../out/renderer/index.html')
// 按鈕文字以 src/renderer/App.tsx 現有的為準：Skills 按鈕沒有中文字（圖示 + 英文字），其餘三個是中文。
const DIALOGS: readonly { name: string; button: string }[] = [
  { name: 'skills', button: 'Skills' }, { name: 'permissions', button: '授權' }, { name: 'chef', button: '主廚' },
  { name: 'test-machines', button: '測試機' }, { name: 'project-run', button: '執行' },
]
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

// 統一輸出契約:每張截圖一行 {check, ok, detail},全部通過才 exit 0。
const results: { check: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ check: name, ok, detail })
  console.log(JSON.stringify({ check: name, ok, detail }))
}

async function main(): Promise<void> {
  await app.whenReady()
  mkdirSync(OUT, { recursive: true })
  // 高度比 brief 原本的 900 高（1300）：對話清單本身只分到約一半高度（其餘給頂欄、
  // 分頁列、待批准列與輸入框），900 塞不下「使用者訊息 + Markdown 回覆 + 一張展開的
  // 已完成工具卡片（含結果）」這三段同時可見，900 只夠露出其中一部分、其餘被清單自己的
  // overflow 裁掉（不是被別的元素蓋住）。加高只是給截圖多一點畫布，不影響 1440 寬度
  // 或版面本身的比例規則。
  const win = new BaseWindow({ width: 1440, height: 1300, show: true, titleBarStyle: 'hiddenInset' })
  const view = new WebContentsView({ webPreferences: { preload: join(__dirname, 'screenshot-preload.cjs'), contextIsolation: true, sandbox: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 1300 })
  await view.webContents.loadURL(pathToFileURL(RENDERER).href)
  await wait(1000)
  const wc = view.webContents
  const shot = async (name: string): Promise<void> => {
    const image = await wc.capturePage()
    const png = image.toPNG()
    const path = join(OUT, `${name}.png`)
    writeFileSync(path, png)
    check(`截圖已存檔:${name}.png`, png.length > 0, path)
  }
  const click = (label: string): Promise<void> => wc.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw new Error('沒有按鈕 ' + ${JSON.stringify(label)}); b.click() })()`)
  /**
   * 對話清單預設「貼底」（`Conversation.tsx` 的 stick 行為：新內容進來永遠捲到最新一則），
   * fixture 塞的內容一次到齊，貼底會把使用者訊息、Markdown 回覆與第一個已完成的工具卡片
   * 捲出視窗外，主畫面截圖只看得到最後一張等待批准的卡片。截圖前手動捲回頂端，
   * 並補一次 scroll 事件讓 `Conversation.tsx` 的 `onScroll` 算出「不貼底」，
   * 之後不會被 ResizeObserver 的貼底邏輯捲回去。
   *
   * 捲到頂端後 `away` 會是 true，`Conversation.tsx` 疊一顆貼在清單底部的「回到最新訊息」
   * 圓角按鈕（`position: absolute; bottom: 14px`，不跟著內容捲動），剛好蓋住捲到頂端後
   * 露出的第一張已完成工具卡片那一行。截圖只是要看內容，把這顆導覽按鈕藏起來。
   */
  // 隱藏那顆按鈕要等 React 真的把 `away` state 的重新渲染畫出來才找得到它（`scroll`
  // 事件觸發的 setState 不是同步生效，用兩層 requestAnimationFrame 等過一次繪製）。
  const scrollConversationToTop = (): Promise<void> => wc.executeJavaScript(`new Promise((resolve) => {
    const el = document.querySelector('.conversation-list')
    if (el) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const backToLatest = document.querySelector('.conversation-latest')
      if (backToLatest) backToLatest.style.display = 'none'
      resolve(undefined)
    }))
  })`)
  /**
   * 這四個對話框只有 `TestMachinesManager` 把 `onClose` 接在原生 `close` 事件上；
   * `SkillsManager`／`ChefManager`／`PermissionManager` 只聽 `onCancel`（按下 Escape
   * 才會發生的事件），監聽器裡自己 `preventDefault()` 再呼叫 `onClose()` 讓 React
   * unmount 掉 `<dialog>`。原本這裡直接呼叫 `HTMLDialogElement.close()`：那只會發出
   * `close` 事件，不會發出 `cancel`，於是那三個對話框的 `onCancel` 永遠不會被呼叫，
   * React 的 `xxxOpen` state 停在 `true`，dark 迴圈的第二次點擊變成 no-op（元件沒有
   * 重新掛載，`showModal()` 不會再被呼叫一次）——`dark-skills.png`／
   * `dark-permissions.png`／`dark-chef.png` 因此跟 `dark-main.png`長得一模一樣。
   *
   * 修正：先在 `<dialog>` 上真的送出一個可取消的 `cancel` 事件（等同使用者按下
   * Escape 時瀏覽器會發的那個），讓三個只聽 `onCancel` 的元件跑到它們自己的
   * `onClose()`；`dispatchEvent` 不會像瀏覽器原生的 Escape 處理一樣「沒被攔截就自動
   * close()」（那個自動關閉是 UA 對「使用者按 Escape」這件事自己做的處理，不是任何
   * `cancel` 事件的通用預設行為），所以後面仍然明確呼叫一次 `d.close()`：對
   * `TestMachinesManager`（沒有 `onCancel` 監聽器）觸發它唯一在聽的原生 `close`
   * 事件；對其他三個，這時 `<dialog>` 多半已經因為 `onClose()` 被 unmount，
   * `d.isConnected` 為 false，這次 `close()` 是安全的空操作。
   */
  const escape = (): Promise<void> => wc.executeJavaScript(`(() => {
    const d = document.querySelector('dialog[open]')
    if (!d) return
    d.dispatchEvent(new Event('cancel', { cancelable: true }))
    if (d.isConnected && d.open) d.close()
  })()`)
  const assertAllDialogsClosed = async (label: string): Promise<void> => {
    const stillOpen = await wc.executeJavaScript(`document.querySelector('dialog[open]') !== null`)
    if (stillOpen) throw new Error(`對話框沒關掉，還留著：${label}`)
  }
  const verifyChefCooldown = async (): Promise<void> => {
    const state = await wc.executeJavaScript(`(async () => {
      const summary = [...document.querySelectorAll('summary')].find((item) => item.textContent?.trim().startsWith('模型池與執行上限'))
      if (summary?.parentElement instanceof HTMLDetailsElement) summary.parentElement.open = true
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const hint = [...document.querySelectorAll('.chef-models small')].find((item) => item.textContent?.startsWith('帳號不支援，'))
      const checkbox = document.querySelector('.chef-models input[type="checkbox"]')
      if (!(checkbox instanceof HTMLInputElement)) return { hint: hint?.textContent, checkboxFound: false }
      const initial = checkbox.checked
      checkbox.click()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const toggled = checkbox.checked !== initial
      checkbox.click()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return { hint: hint?.textContent, checkboxFound: true, enabled: !checkbox.disabled, initiallyChecked: initial, toggled, restored: checkbox.checked === initial }
    })()`)
    const ok = typeof state.hint === 'string' && state.hint.includes('前暫不選用') && state.checkboxFound && state.enabled && state.toggled && state.restored
    check('chef-model-cooldown-interactive', ok, JSON.stringify(state))
    if (!ok) throw new Error(`主廚模型冷卻提示或勾選框檢查失敗：${JSON.stringify(state)}`)
  }
  const selectGroupTab = (): Promise<void> => wc.executeJavaScript(`(() => {
    const tab = document.querySelector('.conversation-tabs [role="tab"][data-provider="group"]')
    if (!tab) throw new Error('沒有群組分頁')
    tab.click()
  })()`)
  const assertGroupVisible = async (theme: string): Promise<void> => {
    const state = await wc.executeJavaScript(`(() => {
      const slot = document.querySelector('.pane-slot-group')
      const visible = (selector) => {
        const element = slot?.querySelector(selector)
        const rect = element?.getBoundingClientRect()
        return Boolean(rect && rect.width > 0 && rect.height > 0)
      }
      return {
        selected: document.querySelector('.conversation-tabs .tab[data-provider="group"]')?.classList.contains('on') === true,
        groupFirst: document.querySelector('.conversation-tabs .tab[role="tab"]')?.getAttribute('data-provider') === 'group',
        groupHasCloseButton: Boolean(slot?.ownerDocument.querySelector('.conversation-tabs .tab[data-provider="group"] .tab-close')),
        splitButton: Boolean(document.querySelector('.quick-launch .split-launch-main') && document.querySelector('.quick-launch .split-launch-menu > summary')),
        threads: visible('.group-threads'),
        messages: visible('.group-stream') && Boolean(slot?.querySelector('.group-message')),
        composer: visible('.group-composer') && visible('.group-input'),
        overflowChecks: (() => {
          const all = [...document.querySelectorAll('.group-thread')].find((button) => button.querySelector('.group-thread-label')?.textContent?.trim() === '全部')
          const unassigned = [...document.querySelectorAll('.group-thread')].find((button) => button.querySelector('.group-thread-label')?.textContent?.trim() === '未分派')
          const pill = (element) => ({ scrollWidth: element?.scrollWidth ?? null, clientWidth: element?.clientWidth ?? null, ok: Boolean(element && element.scrollWidth <= element.clientWidth) })
          const rail = document.querySelector('.conversation-tabs')
          const railStyle = rail ? getComputedStyle(rail) : undefined
          const rightFade = Boolean(document.querySelector('.conversation-tabs-fade--right'))
          const tabs = [...document.querySelectorAll('.conversation-tabs .tab-label')].map((label) => {
            const style = getComputedStyle(label)
            const width = label.getBoundingClientRect().width
            const minimumWidth = Number.parseFloat(style.fontSize) * 2
            const truncated = label.scrollWidth > label.clientWidth
            return { text: label.textContent?.trim(), title: label.closest('.tab')?.getAttribute('title'), truncated, textOverflow: style.textOverflow, width, minimumWidth, ok: !truncated || (style.textOverflow === 'ellipsis' && width >= minimumWidth) }
          })
          const longChef = tabs.find((tab) => tab.title?.startsWith('主廚 · 規劃與執行'))
          const railOverflow = Boolean(rail && rail.scrollWidth > rail.clientWidth)
          const railCanScroll = !railOverflow || ['auto', 'scroll'].includes(railStyle?.overflowX ?? '')
          return { all: pill(all), unassigned: pill(unassigned), rail: { scrollWidth: rail?.scrollWidth ?? null, clientWidth: rail?.clientWidth ?? null, scrollLeft: rail?.scrollLeft ?? null, maxScroll: rail ? rail.scrollWidth - rail.clientWidth : null, overflowX: railStyle?.overflowX ?? 'missing', overflowing: railOverflow, canScroll: railCanScroll, rightFade }, clippedLabels: tabs.filter((tab) => tab.truncated), labels: tabs, longChef: { found: longChef !== undefined, truncated: longChef?.truncated ?? false } }
        })(),
        layout: (() => {
          const slotRect = slot?.getBoundingClientRect()
          const bounds = ['.group-pane', '.group-threads', '.group-composer'].map((selector) => {
            const rect = slot?.querySelector(selector)?.getBoundingClientRect()
            return { selector, right: rect?.right ?? null, slotRight: slotRect?.right ?? null, ok: Boolean(rect && slotRect && rect.right <= slotRect.right + 1) }
          })
          return { bounds, noDocumentOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth }
        })(),
      }
    })()`)
    const overflow = state.overflowChecks
    const threadPillsOkay = overflow.all.ok && overflow.unassigned.ok
    const tabOverflowOkay = overflow.rail.overflowing && overflow.rail.canScroll && overflow.labels.every((label: { ok: boolean }) => label.ok) && overflow.longChef.found && overflow.longChef.truncated
    const rightFadeOkay = overflow.rail.overflowing && overflow.rail.scrollLeft < overflow.rail.maxScroll - 1 && overflow.rail.rightFade
    const groupVisible = state.selected && state.groupFirst && !state.groupHasCloseButton && state.splitButton && state.threads && state.messages && state.composer && state.layout.noDocumentOverflow && state.layout.bounds.every((bound: { ok: boolean }) => bound.ok)
    check(`${theme}-group-thread-pills-unclipped`, threadPillsOkay, JSON.stringify({ all: overflow.all, unassigned: overflow.unassigned }))
    check(`${theme}-conversation-tabs-overflow`, tabOverflowOkay, JSON.stringify({ rail: overflow.rail, clippedLabels: overflow.clippedLabels, longChef: overflow.longChef }))
    check(`${theme}-conversation-tabs-right-fade`, rightFadeOkay, JSON.stringify({ rail: overflow.rail }))
    check(`${theme}-group-visible`, groupVisible, JSON.stringify(state))
    if (!groupVisible || !threadPillsOkay || !tabOverflowOkay || !rightFadeOkay) throw new Error(`群組截圖或溢位檢查失敗：${theme}`)
  }
  const focusLastTabAndCheck = async (): Promise<void> => {
    const activated = await wc.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll('.conversation-tabs [role="tab"]')].find((item) => item.getAttribute('title') === 'Grok · 最後一輪驗收')
      if (!tab) return false
      tab.click()
      return true
    })()`)
    if (!activated) throw new Error('截圖 fixture 沒有最後一個對話分頁')
    await wait(200)
    const state = await wc.executeJavaScript(`(() => {
      const rail = document.querySelector('.conversation-tabs')
      const tab = [...document.querySelectorAll('.conversation-tabs [role="tab"]')].find((item) => item.getAttribute('title') === 'Grok · 最後一輪驗收')
      if (!rail || !tab) return { found: false, active: false, visible: false, leftFade: false, rightFade: false }
      const railRect = rail.getBoundingClientRect()
      const tabRect = tab.getBoundingClientRect()
      const rightFade = document.querySelector('.conversation-tabs-fade--right')
      const leftFade = document.querySelector('.conversation-tabs-fade--left')
      const rightInset = rightFade ? rightFade.getBoundingClientRect().width : 0
      return {
        found: true,
        active: tab.getAttribute('aria-selected') === 'true',
        visible: tabRect.left >= railRect.left - 1 && tabRect.right <= railRect.right - rightInset + 1,
        scrollLeft: rail.scrollLeft,
        maxScroll: rail.scrollWidth - rail.clientWidth,
        leftFade: Boolean(leftFade),
        rightFade: Boolean(rightFade),
      }
    })()`)
    const ok = state.found && state.active && state.visible && state.leftFade && !state.rightFade
    check('conversation-tabs-last-tab-visible', ok, JSON.stringify(state))
    if (!ok) throw new Error(`最後一個對話分頁沒有完整顯示：${JSON.stringify(state)}`)
  }
  /**
   * 已完成的工具卡片預設收合（`ToolCall.tsx`：`open = override ?? status === 'awaiting-approval'`），
   * 收合狀態只看得到名稱與「完成」，看不到規格要看的「工具卡片連同結果」。點一下標題列展開它。
   */
  const expandToolCall = (namePrefix: string): Promise<void> => wc.executeJavaScript(`(() => { const h = [...document.querySelectorAll('.tool-head')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(namePrefix)})); if (h) h.click() })()`)
  const accent = await wc.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() + ' → ' + (() => { const s = document.createElement('span'); s.style.color = 'AccentColor'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c })()`)
  console.log(JSON.stringify({ accent }))
  // 只展開一次：`override` 是 ToolCall 自己的 state，兩種外觀共用同一份掛載，
  // 每個主題各點一次會把它點成「展開 → 收合」，第二次（dark）反而收回去。
  await expandToolCall('mcp__yeschef__view_snapshot')

  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await wait(400)
    await scrollConversationToTop()
    await wait(100)
    await shot(`${theme}-main`)
    for (const dialog of DIALOGS) {
      await click(dialog.button)
      await wait(400)
      if (dialog.name === 'chef') await verifyChefCooldown()
      await shot(`${theme}-${dialog.name}`)
      await escape()
      await wait(200)
      // 沒關掉就直接讓腳本失敗，而不是默默存一張跟上一張重複的截圖。
      await assertAllDialogsClosed(`${theme}-${dialog.name}`)
    }
  }

  await wc.executeJavaScript(`window.yeschef.openGroup('p1')`)
  await wait(200)
  await selectGroupTab()
  await wait(500)
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await wait(400)
    await assertGroupVisible(theme)
    await shot(`${theme}-group`)
  }

  /**
   * 分頁列的新增選單往下展開，會超出分頁列本身的高度。分頁列只要設了非 visible 的 overflow，
   * 選單就會被裁掉，下方的對話或終端內容露出來。用 elementFromPoint 取選單最後一個選項的中心點，
   * 拿到的必須是那個選項本身，被裁掉或被蓋住時會拿到別的元素。
   */
  const splitMenuCheck = async (theme: string): Promise<void> => {
    const state = await wc.executeJavaScript(`new Promise((resolve) => {
      const menu = document.querySelector('.quick-launch .split-launch-menu')
      if (!menu) { resolve({ found: false }); return }
      menu.open = true
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const strip = document.querySelector('.tab-strip')?.getBoundingClientRect()
        const options = [...menu.querySelectorAll('.split-launch-options button')]
        const last = options.at(-1)
        const rect = last?.getBoundingClientRect()
        const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
        resolve({ found: true, options: options.length, stripBottom: strip?.bottom ?? null, lastTop: rect?.top ?? null, extendsBelowStrip: Boolean(rect && strip && rect.top > strip.bottom), hitIsLast: Boolean(last && hit && last.contains(hit)), hit: hit ? hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.') : null })
      }))
    })`)
    const ok = state.found && state.options > 0 && state.extendsBelowStrip && state.hitIsLast
    check(`${theme}-split-launch-menu-unclipped`, ok, JSON.stringify(state))
    await shot(`${theme}-split-launch-menu`)
    await wc.executeJavaScript(`(() => { const menu = document.querySelector('.quick-launch .split-launch-menu'); if (menu) menu.open = false })()`)
    if (!ok) throw new Error(`新增選單被裁掉或被蓋住：${theme}`)
  }
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await wait(400)
    await splitMenuCheck(theme)
  }

  nativeTheme.themeSource = 'light'
  await wait(200)
  await focusLastTabAndCheck()
  await shot('light-tabs-last')

  /**
   * 額外補一組固定在 1440×900（brief 原本給的高度）的主畫面截圖：前面為了同時露出
   * 「使用者訊息＋Markdown 回覆＋一張展開的已完成工具卡片」把視窗加高到 1300，
   * Task 7 若要比對「一般視窗高度下版面長什麼樣子」需要一組跟原始高度一致的基準。
   */
  win.setSize(1440, 900)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  await wait(300)
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await wait(400)
    await scrollConversationToTop()
    await wait(100)
    await shot(`${theme}-main-short`)
  }

  const failed = results.filter((r) => !r.ok).length
  const summaryLine = JSON.stringify({ summary: { total: results.length, failed } })
  // app.exit() 會立刻結束行程,stdout 若接管線寫入是非同步的,用 write 的 callback 確定
  // flush 完最後這行摘要再 exit,避免被截掉。
  process.stdout.write(`${summaryLine}\n`, () => { app.exit(failed === 0 ? 0 : 1) })
}

main().catch((err: unknown) => { console.error(err); app.exit(1) })
