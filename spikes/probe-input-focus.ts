import { app, BaseWindow, WebContentsView } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { attachCdp, type CdpSession } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'

const ITERATIONS = 200
const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 3000

/** 情境的語意鍵值。checkValidity 用這個比對，不用陣列位置，順序調整不會靜默壞掉。 */
type ScenarioKey = 'right' | 'left' | 'blurred'

interface Scenario {
  readonly key: ScenarioKey
  readonly label: string
  focus(win: BaseWindow, terminal: WebContentsView, agent: WebContentsView): void
  /** 這個情境要等到的目標狀態是否已達成，用來決定輪詢何時停止。 */
  isSettled(state: FocusState): boolean
}

const SCENARIOS: readonly Scenario[] = [
  {
    key: 'right',
    label: '右窗格聚焦',
    focus: (_w, _t, a) => a.webContents.focus(),
    isSettled: (s) => s.agentFocused,
  },
  {
    key: 'left',
    label: '左窗格聚焦（使用者在打字）',
    focus: (_w, t) => t.webContents.focus(),
    isSettled: (s) => s.terminalFocused,
  },
  // 不用 win.blur()：Electron 文件對 BaseWindow.blur() 只寫「移除視窗的焦點」，
  // 沒保證焦點會真的轉移到別的應用（macOS 上常常還是留在同一個 app）。
  // app.hide() 是 macOS 上讓整個 app 連同視窗一起離開前景的直接做法，
  // 執行後是否真的讓 win.isFocused() 變成 false，由下面的有效性閘門驗證，
  // 不是假設。
  {
    key: 'blurred',
    label: '整個視窗失焦',
    focus: () => app.hide(),
    isSettled: (s) => !s.winFocused,
  },
]

interface FocusState {
  readonly winFocused: boolean
  readonly terminalFocused: boolean
  readonly agentFocused: boolean
}

function captureFocusState(
  win: BaseWindow,
  terminal: WebContentsView,
  agent: WebContentsView
): FocusState {
  return {
    winFocused: win.isFocused(),
    terminalFocused: terminal.webContents.isFocused(),
    agentFocused: agent.webContents.isFocused(),
  }
}

function describeFocusState(s: FocusState): string {
  return `視窗 isFocused=${s.winFocused} 左窗格 isFocused=${s.terminalFocused} 右窗格 isFocused=${s.agentFocused}`
}

interface PollResult {
  readonly state: FocusState
  /** 到 POLL_TIMEOUT_MS 都沒等到目標狀態，狀態可能還在跨程序切換中，未必穩定。 */
  readonly timedOut: boolean
}

/**
 * 輪詢焦點狀態直到 isSettled 成立或逾時。
 *
 * 情境 3 用 app.hide() 是跨程序、非同步的 OS 層級操作，固定等待時間可能踩不準；
 * 情境 1、2 的 webContents.focus() 雖是同進程呼叫，但也可能受 IPC 往返影響。
 * 輪詢比固定 sleep 更能反映「狀態真的穩定了」而不是「等了一個猜的時間」。
 */
async function pollUntilSettled(
  win: BaseWindow,
  terminal: WebContentsView,
  agent: WebContentsView,
  isSettled: (state: FocusState) => boolean
): Promise<PollResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let state = captureFocusState(win, terminal, agent)
  while (!isSettled(state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    state = captureFocusState(win, terminal, agent)
  }
  return { state, timedOut: !isSettled(state) }
}

async function clickCount(cdp: CdpSession): Promise<number> {
  const r = await cdp.send<{ result: { value: number } }>('Runtime.evaluate', {
    expression: 'window.__clicks',
    returnByValue: true,
  })
  return r.result.value
}

interface ScenarioResult {
  readonly key: ScenarioKey
  readonly label: string
  readonly state: FocusState
  readonly timedOut: boolean
  readonly got: number
  readonly rate: string
}

interface ValidityCheck {
  readonly valid: boolean
  readonly reasons: readonly string[]
}

/**
 * 有效性閘門：三種情境的焦點狀態必須真的互不相同，否則成功率數字沒有意義。
 *
 * - 情境「整個視窗失焦」的 winFocused 必須與「右窗格聚焦」不同
 * - 情境「左窗格聚焦」的 terminalFocused 與 agentFocused 都必須與「右窗格聚焦」不同
 *
 * 用 key（語意）比對，不用陣列位置：SCENARIOS 的順序調整不會讓這裡靜默比錯。
 *
 * 只印一行診斷字不夠：使用者重跑時不會逐字比對三行輸出，這裡要讓「這次的
 * 數字不能用」變成腳本自己講出來的結論與結束碼，而不是靠人眼發現。
 */
function checkValidity(results: readonly ScenarioResult[]): ValidityCheck {
  const byKey = new Map(results.map((r) => [r.key, r] as const))
  const right = byKey.get('right')
  const left = byKey.get('left')
  const blurred = byKey.get('blurred')
  if (!right || !left || !blurred) {
    return { valid: false, reasons: ['情境數量不足，無法比對'] }
  }

  const reasons: string[] = []

  if (blurred.state.winFocused === right.state.winFocused) {
    reasons.push(
      `「整個視窗失焦」的視窗 isFocused=${blurred.state.winFocused} 與「右窗格聚焦」相同，視窗實際上沒有真的失焦`
    )
  }

  if (left.state.terminalFocused === right.state.terminalFocused) {
    reasons.push(
      `「左窗格聚焦」的左窗格 isFocused=${left.state.terminalFocused} 與「右窗格聚焦」相同，左窗格實際上沒有真的拿到焦點`
    )
  }

  if (left.state.agentFocused === right.state.agentFocused) {
    reasons.push(
      `「左窗格聚焦」的右窗格 isFocused=${left.state.agentFocused} 與「右窗格聚焦」相同，右窗格實際上沒有真的失去焦點`
    )
  }

  return { valid: reasons.length === 0, reasons }
}

async function run(): Promise<void> {
  const win = new BaseWindow({ width: 1600, height: 900 })
  const terminal = new WebContentsView({ webPreferences: { sandbox: true } })
  const agent = createAgentView({
    // 探針沒有專案概念:用 cwd 當範圍,http/https 不受這個值影響。
    currentProjectDir: () => process.cwd(),
    logError: (error) => console.error('[spike]', error),
  }, 'persist:agent')
  win.contentView.addChildView(terminal)
  win.contentView.addChildView(agent)

  win.show()
  app.focus({ steal: true })
  win.focus()
  await new Promise((r) => setTimeout(r, 300))
  console.log(`啟動後：視窗 isVisible=${win.isVisible()} isFocused=${win.isFocused()}`)

  // 對半切的兩格。主程式已經不再對半切(renderer 決定擺位),這支試驗只需要固定的兩格。
  const left = { x: 0, y: 0, width: 800, height: 900 }
  const right = { x: 800, y: 0, width: 800, height: 900 }
  terminal.setBounds(left)
  agent.setBounds(right)

  await terminal.webContents.loadURL('data:text/html,<input autofocus>')
  const fixture = pathToFileURL(join(__dirname, '../tests/fixtures/click-counter.html')).href
  await agent.webContents.loadURL(fixture)

  const cdp = await attachCdp(agent.webContents)

  // 按鈕在右窗格中央。座標是相對 view 而非視窗。
  const x = Math.round(right.width / 2)
  const y = Math.round(right.height / 2)

  const results: ScenarioResult[] = []

  for (const scenario of SCENARIOS) {
    await agent.webContents.executeJavaScript('window.__clicks = 0')
    scenario.focus(win, terminal, agent)

    const { state, timedOut } = await pollUntilSettled(win, terminal, agent, scenario.isSettled)
    const timeoutNote = timedOut ? `（逾時 ${POLL_TIMEOUT_MS}ms，狀態可能未穩定）` : ''
    console.log(`[${scenario.label}] 焦點狀態：${describeFocusState(state)}${timeoutNote}`)

    for (let i = 0; i < ITERATIONS; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      })
    }

    await new Promise((r) => setTimeout(r, 500))
    const got = await clickCount(cdp)
    const rate = ((got / ITERATIONS) * 100).toFixed(1)
    console.log(`${scenario.label.padEnd(26)} ${got}/${ITERATIONS}  成功率 ${rate}%`)
    results.push({ key: scenario.key, label: scenario.label, state, timedOut, got, rate })
  }

  cdp.detach()

  const { valid, reasons } = checkValidity(results)

  console.log('========================================')
  if (valid) {
    console.log('量測有效：三種焦點狀態確實互不相同，以上成功率可用於判準')
    console.log('========================================')
    app.quit()
    return
  }

  console.log('!!!! 量測無效：焦點狀態未能真正切換 !!!!')
  console.log('!!!! 以上成功率數字不能用於 99% 判準 !!!!')
  console.log('========================================')
  for (const reason of reasons) {
    console.log(`  - ${reason}`)
  }
  // 用非零碼結束，讓自動化或人工重跑時不會誤把這次的輸出當成有效結果。
  // 先給 stdout 一點時間把上面的行寫出去，app.exit() 不等非同步清理。
  await new Promise((r) => setTimeout(r, 100))
  app.exit(1)
}

app.whenReady().then(run, (e: unknown) => {
  console.error('probe-input-focus 執行失敗：', e)
  app.exit(1)
})
