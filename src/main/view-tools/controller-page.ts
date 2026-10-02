/** 頁面層級的三個工具：view_navigate、view_snapshot、view_screenshot。 */
import { MSG, ViewToolError } from './errors.js'
import { NAVIGATE_TIMEOUT_MS, SETTLE_QUIET_MS } from './settle.js'
import { buildSnapshot, formatSnapshotText } from './snapshot.js'
import { collectSnapshotInput } from './snapshot-collect.js'
import { checkNavigateUrl } from './urls.js'
import { summarizeIntervention } from './watch.js'
import { text, type ControllerCore } from './controller-core.js'
import { SCREENSHOT_MAX_WIDTH, type ToolOutput } from './controller-types.js'

interface LayoutMetrics {
  readonly cssVisualViewport: { readonly clientWidth: number; readonly clientHeight: number }
}

export function createPageTools(core: ControllerCore): {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    navigate: (url, signal) =>
      core.act(signal, async () => {
        // 檢查順序：協定與專案範圍先擋掉，不合格的網址不該送進 CDP。
        const check = checkNavigateUrl(url, deps.projectDir())
        if (check.kind === 'invalid') throw new ViewToolError(MSG.invalidUrl(url))
        if (check.kind === 'bad-scheme') throw new ViewToolError(MSG.badScheme)
        if (check.kind === 'outside-project') throw new ViewToolError(MSG.outsideProject(check.projectDir))

        // 裁決 13：走 Page.navigate 而不是 wc.loadURL，才拿得到 errorText。
        const result = await call<{ readonly errorText?: string }>('Page.navigate', { url: check.url })
        const errorText = result.errorText
        if (typeof errorText === 'string' && errorText !== '') {
          throw new ViewToolError(MSG.navigateFailed(check.url, errorText))
        }

        const outcome = await deps.settle.waitForLoad({
          quietMs: SETTLE_QUIET_MS,
          timeoutMs: NAVIGATE_TIMEOUT_MS,
          signal,
        })
        if (outcome === 'timeout') throw new ViewToolError(MSG.navigateTimeout(deps.webContents.getURL()))
        if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)

        return text(MSG.navigated(deps.webContents.getURL(), deps.webContents.getTitle()))
      }),

    snapshot: (scope, signal) =>
      core.act(signal, async () => {
        const id = core.nextSnapshotId()
        const input = await collectSnapshotInput(core.collect, id, scope)
        const built = buildSnapshot(input)
        deps.watcher.setRefs(built.refs)
        // takeIntervention 要在 setRefs 之後、回傳之前呼叫：這一次 snapshot 就是
        // 「上次操作」的新起點，摘要交給模型看過就歸零。
        const summary = summarizeIntervention(deps.watcher.takeIntervention(), deps.webContents.getURL())
        return text(formatSnapshotText(built.snapshot, summary))
      }),

    screenshot: (signal) =>
      core.act(signal, async () => {
        const metrics = await call<LayoutMetrics>('Page.getLayoutMetrics')
        const width = metrics.cssVisualViewport.clientWidth
        const height = metrics.cssVisualViewport.clientHeight
        // 寬度為 0（頁面還沒排版完）時不縮放，避免 1280 / 0 得到 Infinity。
        const scale = width > 0 ? Math.min(1, SCREENSHOT_MAX_WIDTH / width) : 1
        const shot = await call<{ readonly data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width, height, scale },
        })
        return {
          kind: 'image',
          text: MSG.screenshot(Math.round(width * scale), Math.round(height * scale), deps.webContents.getURL()),
          dataBase64: shot.data,
          mimeType: 'image/png',
        }
      }),
  }
}
