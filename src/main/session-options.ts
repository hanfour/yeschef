import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { buildSessionOptions, type SessionOptions } from './session-args.js'
import type { SessionStore } from './session-store.js'

/**
 * 回傳的函式每次開 query 都會呼叫，`resumeSessionId` 由狀態機的 `start-query` effect 帶進來。
 *
 * 裁決 20：resume 一場歷史對話時，cwd 用那場對話自己的目錄（`sessions.cwdOf()`），
 * 問不到才退回 `projectDir`。只依賴 `cwdOf` 一個方法，所以參數型別是
 * `Pick<...>`：這裡不需要 `list()` 與 `loadHistory()`。
 *
 * `appDir` 由呼叫端傳進來而不是自己向 electron 要：這支檔案因此在 node 環境載得起來，
 * cwd 的選擇規則才測得到。`index.ts` 傳的是 `app.getAppPath()`。
 */
export interface AutoCompactConfig {
  /** 見 `SessionArgsInput.autoCompactWindow`。 */
  readonly window: number
  /** 子程序要保留的環境，`index.ts` 傳 `process.env`。 */
  readonly baseEnv: Readonly<Record<string, string | undefined>>
}

export function createSessionOptionsFactory(
  projectDir: string,
  appDir: string,
  sessions: Pick<SessionStore, 'cwdOf'>,
  mcpServers?: Readonly<Record<string, McpServerConfig>>,
  autoCompact?: AutoCompactConfig,
  sharedPlugins?: () => { type: 'local'; path: string }[]
): (resumeSessionId?: string) => SessionOptions {
  return (resumeSessionId) => {
    const options = buildSessionOptions({
      projectDir:
        (resumeSessionId === undefined ? undefined : sessions.cwdOf(resumeSessionId)) ?? projectDir,
      appDir,
      resumeSessionId,
      mcpServers,
      ...(autoCompact === undefined
        ? {}
        : { autoCompactWindow: autoCompact.window, baseEnv: autoCompact.baseEnv }),
    })
    const plugins = sharedPlugins?.() ?? []
    return plugins.length ? { ...options, plugins } : options
  }
}
