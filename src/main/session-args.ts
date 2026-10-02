import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { McpServerConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk'

export interface SessionArgsInput {
  /** 使用者實際工作的專案目錄。決定 Insights 的歸屬，必須是絕對路徑且存在。 */
  readonly projectDir: string
  /** 本 app 自身的目錄（`app.getAppPath()`）。 */
  readonly appDir: string
  /** 有值時接續既有 session。 */
  readonly resumeSessionId?: string
  /**
   * 程序內 MCP server。子專案 B 由 `index.ts` 傳入 `{ yeschef: viewTools.server }`。
   * 沒給時輸出的 `SessionOptions` 完全不帶 `mcpServers` 這個 key（契約 §11.1）。
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>
  /**
   * auto-compact 的視窗（token）。給了才會輸出 `env`。
   *
   * SDK 換算成 `autoCompactThreshold = rawMaxTokens − 29,384`，並把值夾在下限
   * 100,000，所以門檻的地板是 70,616（RESULTS-10 實測）。壓縮觸發後 context 掉回
   * 兩萬多，之後每一輪的快取讀取量跟著降，這是目前壓成本最便宜的做法。
   */
  readonly autoCompactWindow?: number
  /**
   * 子程序的基礎環境，`autoCompactWindow` 有值時才會用到。
   *
   * SDK 的 `Options.env` 是整包取代不是合併（`sdk.mjs` 的預設值是
   * `{...process.env}`），只塞一個變數會讓子程序失去 PATH 之類的東西，
   * 所以呼叫端要把要保留的環境一起傳進來。
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>
}

export interface SessionOptions {
  readonly disallowedTools?: string[]
  readonly model?: string
  readonly maxTurns?: number
  readonly plugins?: { type: 'local'; path: string }[]
  readonly cwd: string
  /**
   * 明確傳 'default'。
   * 'manual' 過不了 typecheck，且執行期會靜默降級為 'default'；
   * 省略此欄位則落到 'auto'，那是第三種行為。
   */
  readonly permissionMode: 'default'
  /** 逐字串流的前提。 */
  readonly includePartialMessages: true
  /**
   * 只載入專案層的設定，不載入使用者層的 `~/.claude/settings.json`。
   *
   * 省略這個欄位時 SDK 載入 user／project／local 三層（sdk.d.ts:2051-2061）。
   * 使用者層若寫 `permissions.defaultMode: "auto"`，讀取類工具會由模型分類器
   * 直接放行，`canUseTool` 根本不會被呼叫（sdk.d.ts:4771 說明 `canUseTool`
   * 只是 ask 那條路的介面），上面那行明寫的 `permissionMode: 'default'` 形同虛設，
   * YesChef 的批准卡看不到那些工具。RESULTS-08 實測到這個行為。
   *
   * 不傳 `[]`：那會連專案的 CLAUDE.md 一起關掉（sdk.d.ts:2059 要求含 `'project'`）。
   * 代價是使用者層的 `permissions.allow` 清單與 hook 在 yeschef 的 session 不生效，
   * 這是刻意的：權限決定應該由 yeschef 自己問。
   */
  readonly settingSources: SettingSource[]
  readonly resume?: string
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>
  /** 見 `SessionArgsInput.autoCompactWindow`。沒設定時整個 key 不存在。 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 把路徑正規化到可比較的形式。
 *
 * 用 realpath 而非 resolve：macOS 的檔案系統大小寫不敏感，而 resolve() 不做
 * 大小寫正規化也不解符號連結。實機驗證 resolve('.../YesChef') 回傳 '.../YesChef'，
 * realpathSync.native() 回傳 '.../yeschef'，兩者是同一個 inode。
 */
/** 見 `SessionOptions.settingSources` 的說明。 */
const PROJECT_ONLY_SETTINGS: readonly SettingSource[] = ['project', 'local']

/**
 * 基礎環境加上 auto-compact 視窗。值為 `undefined` 的丟掉：SDK 的 env 型別是
 * `Record<string, string>`，而 `process.env` 的值是 `string | undefined`。
 */
function buildEnv(
  base: Readonly<Record<string, string | undefined>> | undefined,
  window: number
): Record<string, string> {
  const kept = Object.entries(base ?? {}).flatMap(([k, v]) =>
    v === undefined ? [] : [[k, v] as const]
  )
  return { ...Object.fromEntries(kept), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) }
}

function canonical(p: string): string {
  return realpathSync.native(resolve(p))
}

/**
 * 組出 SDK query() 的 options。
 *
 * projectDir 落在 app 自身的路徑樹裡（相等或為其子目錄）會讓整場 session 的
 * 逐字稿落在被 Insights 排除的路徑下，而且完全靜默：沒有錯誤、agent 正常運作、
 * 月底才發現少了一批 session。見規格 §2.1。
 */
export function buildSessionOptions(input: SessionArgsInput): SessionOptions {
  if (!input.projectDir.startsWith('/')) {
    throw new Error('projectDir 必須是絕對路徑')
  }

  let projectReal: string
  try {
    projectReal = canonical(input.projectDir)
  } catch (err) {
    // 帶上 cause：訊息只說「不存在」，但 realpath 也會因為權限不足或路徑中間
    // 有一段不是目錄而失敗，那些只有原始錯誤的 code 分得出來。
    throw new Error(`projectDir 不存在：${input.projectDir}`, { cause: err })
  }
  const appReal = canonical(input.appDir)

  if (projectReal === appReal || projectReal.startsWith(appReal + sep)) {
    throw new Error(
      `projectDir 不可為 app 自身目錄或其子目錄：${projectReal}\n` +
        `這會讓這場 session 的逐字稿落在被 Insights 排除的路徑下。`
    )
  }

  return {
    cwd: input.projectDir,
    permissionMode: 'default',
    includePartialMessages: true,
    settingSources: [...PROJECT_ONLY_SETTINGS],
    ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    ...(input.autoCompactWindow === undefined
      ? {}
      : { env: buildEnv(input.baseEnv, input.autoCompactWindow) }),
  }
}
