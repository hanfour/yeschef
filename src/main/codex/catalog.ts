import { homedir } from 'node:os'
import { MSG_NO_CODEX } from './conversation.js'
import { withAuthHint } from './mapper.js'
import { isRecord } from '../../shared/ipc.js'
import type { SessionSummary } from '../../shared/ipc.js'
import type { CodexProcess, SpawnCodex } from './client.js'
import { createRpc } from '../jsonrpc-stdio.js'

export const ITEMS_MAX_PAGES = 20

export interface CodexCatalog {
  items(cwd: string, threadId: string): Promise<readonly unknown[]>
  list(cwd?: string): Promise<readonly SessionSummary[]>
}

/** 只驗證清單會使用的欄位,避免協定新增其他欄位時讓整份清單失效。 */
export function toSummary(thread: unknown): SessionSummary | undefined {
  if (!isRecord(thread)) return undefined
  const { id, preview, updatedAt, cwd, name, gitInfo } = thread
  if (typeof id !== 'string' || id === '' || typeof preview !== 'string' ||
      typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || typeof cwd !== 'string') return undefined
  if (name !== undefined && name !== null && typeof name !== 'string') return undefined
  if (gitInfo !== undefined && gitInfo !== null && !isRecord(gitInfo)) return undefined
  const branch = isRecord(gitInfo) ? gitInfo['branch'] : undefined
  if (branch !== undefined && branch !== null && typeof branch !== 'string') return undefined
  const firstLine = (preview.split(/\r?\n/, 1)[0] ?? '').trim()
  const summary = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
  return {
    sessionId: id,
    summary: summary === '' ? id.slice(0, 8) : summary,
    lastModified: updatedAt < 1e12 ? updatedAt * 1000 : updatedAt,
    cwd,
    ...(typeof name === 'string' && name !== '' ? { customTitle: name } : {}),
    ...(typeof branch === 'string' ? { gitBranch: branch } : {}),
  }
}

export function createCodexCatalog(deps: {
  spawn: SpawnCodex
  logError(e: Error): void
  timeoutMs?: number
}): CodexCatalog {
  const query = async <T>(cwd: string | undefined, read: (rpc: ReturnType<typeof createRpc>) => Promise<T>): Promise<T> => {
    // 每次查詢各自擁有子程序,重疊的刷新不會互相關掉對方的連線。
    let proc: CodexProcess | undefined
    let rpc: ReturnType<typeof createRpc> | undefined
    try {
      proc = deps.spawn(cwd ?? homedir())
      const child = proc
      const r = createRpc({
        write: (line) => { child.write(line) },
        onLine: (cb) => { child.onLine(cb) },
      }, deps.logError, deps.timeoutMs ?? 15_000)
      rpc = r
      child.onError((error) => { r.rejectAll(error) })
      child.onExit((code) => { r.rejectAll(new Error(`codex 子程序已結束(code ${code ?? 'null'})`)) })
      await r.request('initialize', {
        clientInfo: { name: 'yeschef', title: 'YesChef', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      })
      r.notify('initialized')
      return await read(r)
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      deps.logError(error)
      // 錯誤必須往 renderer 傳,Recents 才能顯示列不出來的原因。
      const missing = 'code' in error && error.code === 'ENOENT'
      throw new Error(missing ? MSG_NO_CODEX : withAuthHint(error.message))
    } finally {
      rpc?.rejectAll(new Error('codex 清單查詢已結束'))
      proc?.kill()
    }
  }
  let pendingLists: ReadonlyMap<string | undefined, Promise<readonly SessionSummary[]>> = new Map()
  return {
    list: (cwd) => {
      const pending = pendingLists.get(cwd)
      if (pending !== undefined) return pending
      const request = query(cwd, async (r) => {
        const result = await r.request<unknown>('thread/list', {
          ...(cwd === undefined ? {} : { cwd: [cwd] }),
          sortKey: 'updated_at',
          sortDirection: 'desc',
          limit: 50,
          archived: false,
        })
        if (!isRecord(result) || !Array.isArray(result['data'])) throw new Error('codex thread/list 回傳的形狀不符')
        return result['data'].flatMap((thread: unknown) => {
          const summary = toSummary(thread)
          return summary === undefined ? [] : [summary]
        })
      }).finally(() => {
        // 成功或失敗都移除,下一次刷新才會重新查詢。
        pendingLists = new Map([...pendingLists].filter(([key]) => key !== cwd))
      })
      pendingLists = new Map([...pendingLists, [cwd, request]])
      return request
    },
    items: (cwd, threadId) => query(cwd, async (r) => {
      let items: readonly unknown[] = []
      let cursor: string | undefined
      let cursors: readonly string[] = []
      let useTurns = false
      do {
        const method = useTurns ? 'thread/turns/list' : 'thread/items/list'
        let result: unknown
        try {
          result = await r.request<unknown>(method, {
            threadId, limit: useTurns ? 50 : 200,
            ...(useTurns ? { sortDirection: 'asc', itemsView: 'full' } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          })
        } catch (error) {
          // 新版 CLI 移除跨 turn 的 items/list；只在明確不支援時改用新版分頁，
          // 認證、逾時或讀取錯誤不可被 fallback 掩蓋。
          if (!useTurns && cursor === undefined && error instanceof Error &&
              /thread\/items\/list/.test(error.message) && /unknown variant|method not found|unsupported method/i.test(error.message)) {
            useTurns = true
            continue
          }
          throw error
        }
        if (!isRecord(result) || !Array.isArray(result['data'])) throw new Error(`codex ${method} 回傳的形狀不符`)
        // schema 的 data 是 ThreadItemEntry,完成事件只需要裡面的 ThreadItem。
        const page = result['data'].flatMap((entry: unknown) => {
          if (useTurns) {
            if (!isRecord(entry) || !Array.isArray(entry['items']) ||
                (entry['itemsView'] !== undefined && entry['itemsView'] !== 'full')) {
              throw new Error('codex thread/turns/list 未回傳完整 items')
            }
            return entry['items'].filter((item: unknown) => {
              if (isRecord(item)) return true
              deps.logError(new Error('codex thread/turns/list item 形狀不符'))
              return false
            })
          }
          if (!isRecord(entry) || !isRecord(entry['item'])) {
            deps.logError(new Error('codex thread/items/list item 形狀不符'))
            return []
          }
          return [entry['item']]
        })
        const combined = [...items, ...page]
        items = useTurns ? combined.slice(0, 4000) : combined
        const next = result['nextCursor']
        if (useTurns && (combined.length > 4000 || (items.length === 4000 && next != null))) {
          deps.logError(new Error(`thread ${threadId} 超過 4000 筆,只載入前 4000 筆`))
          return items
        }
        if (next === undefined || next === null) return items
        if (typeof next !== 'string' || cursors.includes(next)) throw new Error(`codex ${method} cursor 形狀不符或重複`)
        // 已走過的 cursor 比頁數少一,到上限就保留已載入的歷史。
        if (cursors.length + 1 >= ITEMS_MAX_PAGES) {
          deps.logError(new Error(useTurns
            ? `thread ${threadId} 超過 20 頁,只載入目前 ${items.length} 筆`
            : `thread ${threadId} 超過 20 頁,只載入前 4000 筆`))
          return items
        }
        cursor = next
        cursors = [...cursors, next]
      } while (true)
    }),
  }
}
