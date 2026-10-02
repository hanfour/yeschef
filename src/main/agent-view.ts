import { WebContentsView } from 'electron'
import { decideWindowOpen } from './view-tools/window-open.js'

export { agentPartitionFor } from './agent-partition.js'

export interface AgentViewDeps {
  /** 這個 view 所屬對話的專案根目錄;對話已不在任何專案裡時回 undefined。 */
  currentProjectDir(): string | undefined
  logError(error: Error): void
}

/**
 * 建立 agent 用的瀏覽器 view。
 *
 * 不給 preload：這個 view 會載入任意網站，任何注入的橋接都是攻擊面。
 * 內容一律由主程序透過 CDP 主動取，不由頁面主動推。
 */
export function createAgentView(deps: AgentViewDeps, partition: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  // 收起右側時這個 view 會被 setVisible(false)。預設的背景降速會讓頁面計時器降到
  // 十分之一、visibilityState 變 hidden,agent 正在操作的頁面行為會跟看得到時不一樣
  // (2026-09-11 量過兩次,見規格 §3)。
  view.webContents.setBackgroundThrottling(false)

  // 規格 §3.3：不做多視窗。target="_blank" 或 window.open() 一律在原地
  // 導航，不開新的 BrowserWindow——那個新視窗不在 CDP session 掌握內，
  // 第二份計畫的 agent 會直接失去頁面，且沒有任何訊號。
  //
  // 規格 §7：這條路的網址由頁面決定，所以要套與 view_navigate 同一份協定白名單
  // 與專案範圍限制，判斷在 view-tools/window-open.ts。
  view.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, deps.currentProjectDir())
    if (decision.kind === 'block') {
      deps.logError(new Error(`右窗格 window-open 已擋下 ${url}：${decision.reason}`))
      return { action: 'deny' }
    }
    view.webContents.loadURL(decision.url).catch((err: unknown) => {
      deps.logError(
        err instanceof Error
          ? new Error(`右窗格 window-open 導航失敗 ${decision.url}：${err.message}`, { cause: err })
          : new Error(`右窗格 window-open 導航失敗 ${decision.url}：${String(err)}`)
      )
    })
    return { action: 'deny' }
  })

  return view
}
