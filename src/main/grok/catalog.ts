/**
 * 模型清單與歷史 session 清單(grok 規格 §5.5)。
 *
 * 開一個短命的 `grok agent stdio`,`initialize` 之後同一個連線把兩件事一起做完再收掉,
 * 結果各快取 30 秒。找不到 grok 時一律回空清單:歷史清單與 Chef 不能因為沒裝 grok 而壞掉。
 */
import { homedir } from 'node:os'
import { isRecord, type SessionSummary } from '../../shared/ipc.js'
import { createRpc } from '../jsonrpc-stdio.js'
import { nodeSpawnGrok, readModels, trackGrokProcess, untrackGrokProcess, type GrokModel, type SpawnGrok } from './client.js'

export const GROK_CACHE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 15_000
const SUMMARY_MAX = 80

export interface GrokCatalog {
  /** initialize 回應的 availableModels。找不到 grok 回空陣列。 */
  models(): Promise<readonly GrokModel[]>
  /** `session/list`。形狀與 `CodexCatalog.list` 相同,ipc-bridge 用同一張表查。 */
  list(cwd?: string): Promise<readonly SessionSummary[]>
}

export interface GrokCatalogDeps {
  readonly spawn?: SpawnGrok
  readonly logError: (error: Error) => void
  readonly timeoutMs?: number
  readonly cacheMs?: number
  readonly now?: () => number
  readonly homeDir?: string
}

/** grok 1.0.40 實際回的 `updatedAt` 是 ISO 字串;數字沿用秒／毫秒判斷。解不出日期回 NaN。 */
function parseUpdatedAt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : NaN
  return typeof value === 'string' ? Date.parse(value) : NaN
}

/** 只驗證清單會用到的欄位,協定新增其他欄位時不讓整份清單失效。 */
export function toGrokSummary(raw: unknown): SessionSummary | undefined {
  if (!isRecord(raw)) return undefined
  const { sessionId, cwd } = raw
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string') return undefined
  const lastModified = parseUpdatedAt(raw['updatedAt'])
  if (!Number.isFinite(lastModified)) return undefined
  const wrap = raw['_meta']
  const session = isRecord(wrap) ? wrap['x.ai/session'] : undefined
  const title = isRecord(session) ? session['title'] : undefined
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const summary = trimmed.length > SUMMARY_MAX ? `${trimmed.slice(0, SUMMARY_MAX)}…` : trimmed
  return {
    sessionId,
    summary: summary === '' ? sessionId.slice(0, 8) : summary,
    lastModified,
    cwd,
  }
}

interface Probe {
  readonly models: readonly GrokModel[]
  readonly sessions: readonly SessionSummary[]
}

const EMPTY: Probe = { models: [], sessions: [] }

export function createGrokCatalog(deps: GrokCatalogDeps): GrokCatalog {
  const spawn = deps.spawn ?? nodeSpawnGrok
  const now = deps.now ?? (() => Date.now())
  const cacheMs = deps.cacheMs ?? GROK_CACHE_MS
  const home = deps.homeDir ?? homedir()
  let cache: ReadonlyMap<string, { readonly at: number; readonly value: Probe }> = new Map()
  let inflight: ReadonlyMap<string, Promise<Probe>> = new Map()

  /** 一個短命連線,initialize 取模型、session/list 取該 cwd 的 session,然後收掉。 */
  const probe = async (cwd: string): Promise<Probe> => {
    const proc = spawn(cwd)
    // 探測用的短命子行程也要登記,app 結束時才不會留下孤兒(規格 §5.2)。
    trackGrokProcess(proc)
    const rpc = createRpc({ write: (line) => { proc.write(line) }, onLine: (cb) => { proc.onLine(cb) } }, deps.logError, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'grok')
    proc.onStderr(() => {})
    proc.onError((error) => { rpc.rejectAll(error) })
    proc.onExit((code) => { rpc.rejectAll(new Error(`grok 子行程已結束(code ${code ?? 'null'})`)) })
    try {
      const initialize = await rpc.request<unknown>('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'yeschef', version: '0.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const listed = await rpc.request<unknown>('session/list', { cwd })
      const sessions = isRecord(listed) ? listed['sessions'] : undefined
      return {
        models: readModels(initialize),
        sessions: Array.isArray(sessions)
          ? sessions.flatMap((entry: unknown) => { const one = toGrokSummary(entry); return one === undefined ? [] : [one] })
          : [],
      }
    } finally {
      rpc.rejectAll(new Error('grok 清單查詢已結束'))
      proc.closeStdin()
      proc.kill()
      untrackGrokProcess(proc)
    }
  }

  const fresh = (cwd: string): Probe | undefined => {
    const hit = cache.get(cwd)
    return hit !== undefined && now() - hit.at < cacheMs ? hit.value : undefined
  }

  const load = (cwd: string): Promise<Probe> => {
    const cached = fresh(cwd)
    if (cached !== undefined) return Promise.resolve(cached)
    const running = inflight.get(cwd)
    if (running !== undefined) return running
    const task = probe(cwd).catch((cause: unknown) => {
      // 找不到 grok、沒登入、逾時都只記 log:清單其他部分照常(規格 §5.5)。
      deps.logError(cause instanceof Error ? cause : new Error(String(cause)))
      return EMPTY
    }).then((value) => {
      cache = new Map([...cache, [cwd, { at: now(), value }]])
      return value
    }).finally(() => {
      inflight = new Map([...inflight].filter(([key]) => key !== cwd))
    })
    inflight = new Map([...inflight, [cwd, task]])
    return task
  }

  return {
    models: async () => {
      // 模型與 cwd 無關,但要跟 session 清單共用同一個連線:先看有沒有新鮮快取。
      const anyFresh = [...cache.values()].find((entry) => now() - entry.at < cacheMs)
      if (anyFresh !== undefined) return anyFresh.value.models
      // 讓同一輪事件迴圈裡的 list() 呼叫有機會先掛進 inflight,兩者才能搭同一個連線,
      // 不然 models() 一叫就自己開一個,跟 list() 各開各的。
      await Promise.resolve()
      const running = [...inflight.values()][0]
      if (running !== undefined) return (await running).models
      const stillFresh = [...cache.values()].find((entry) => now() - entry.at < cacheMs)
      if (stillFresh !== undefined) return stillFresh.value.models
      return (await load(home)).models
    },
    list: async (cwd) => (await load(cwd ?? home)).sessions,
  }
}
