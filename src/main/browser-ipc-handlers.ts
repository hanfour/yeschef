import { parseBrowserCommand, type BrowserCommand, type BrowserCommandResult, type BrowserSnapshot } from '../shared/browser-ipc.js'
import { IPC } from '../shared/ipc.js'
import { MSG } from './view-tools/errors.js'

export interface BrowserIpcHandlersDeps {
  isTrustedSender(sender: unknown): boolean
  commands: { run(command: BrowserCommand): Promise<BrowserCommandResult> }
  snapshot(): BrowserSnapshot
  logError(error: Error): void
}

export interface BrowserIpcHandlers {
  onCommand(event: { sender: unknown }, raw: unknown): Promise<BrowserCommandResult>
  onGet(event: { sender: unknown }): BrowserSnapshot
}

/**
 * 網址列與工具共用的兩條瀏覽器 IPC 通道(browser:command、browser:get)。
 * 只接受左窗格的呼叫,行為與抽出前的 index.ts 一致:來源不對就丟例外,
 * payload 格式不對只記錯誤、回 ok:false,不丟給 commands.run。
 */
export function createBrowserIpcHandlers(deps: BrowserIpcHandlersDeps): BrowserIpcHandlers {
  const requireTrusted = (channel: string, event: { sender: unknown }): void => {
    if (!deps.isTrustedSender(event.sender)) throw new Error(`${channel} 只接受左窗格的呼叫`)
  }

  const onCommand = async (event: { sender: unknown }, raw: unknown): Promise<BrowserCommandResult> => {
    requireTrusted(IPC.browserCommand, event)
    const command = parseBrowserCommand(raw)
    if (command === null) {
      deps.logError(new Error(`${IPC.browserCommand} 收到格式不對的 payload`))
      return { ok: false, message: MSG.internal(MSG.badCommand) }
    }
    return deps.commands.run(command)
  }

  const onGet = (event: { sender: unknown }): BrowserSnapshot => {
    requireTrusted(IPC.browserGet, event)
    return deps.snapshot()
  }

  return { onCommand, onGet }
}
