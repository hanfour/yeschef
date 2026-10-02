/**
 * 群組訊息的落地(群組規格 §3.2)。每個專案一個 append-only NDJSON,
 * 放 `<userData>/yeschef-group/<projectId>.ndjson`。
 *
 * 不放專案目錄的理由跟同伴信箱一樣:那裡可能被 `git clean -fdx` 清掉。
 * 程式中斷最多壞最後一行,讀取時跳過解析失敗的行並記一次 log。
 */
import { mkdir, appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { GROUP_READ_LIMIT, GroupMessageSchema, type GroupMessage } from '../../shared/group.js'

/** 超過就把前半裁掉:留一半比留全部安全,也不用逐則計數。 */
export const GROUP_FILE_MAX_BYTES = 5 * 1024 * 1024

export interface GroupStore {
  append(message: GroupMessage): Promise<void>
  /** 最後 `GROUP_READ_LIMIT` 則,舊到新。檔案不存在回空陣列。 */
  read(projectId: string): Promise<readonly GroupMessage[]>
  dispose(): Promise<void>
}

/** projectId 會變成檔名,不能帶路徑分隔符或上層參照。 */
function fileNameOf(projectId: string): string {
  if (projectId === '' || /[\\/]/.test(projectId) || projectId.includes('..')) {
    throw new Error(`群組訊息的專案代號不合法:${projectId}`)
  }
  return `${projectId}.ndjson`
}

function decode(text: string, onSkipped: (count: number) => void): readonly GroupMessage[] {
  const out: GroupMessage[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { skipped += 1; continue }
    const parsed = GroupMessageSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
    else skipped += 1
  }
  if (skipped > 0) onSkipped(skipped)
  return out
}

export function createGroupStore(dir: string, logError: (error: Error) => void): GroupStore {
  /** 每個專案一條 promise 鏈:兩個來源同時追加也不會交錯成壞行。 */
  let chains = new Map<string, Promise<void>>()
  let ready: Promise<void> | undefined

  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined)
    return ready
  }

  const serialize = (projectId: string, work: () => Promise<void>): Promise<void> => {
    const previous = chains.get(projectId) ?? Promise.resolve()
    const next = previous.then(work, work)
    chains = new Map([...chains, [projectId, next.catch(() => undefined)]])
    return next
  }

  /** 超過上限就讀進來、留後半、原子寫回。失敗只記 log,原檔留著。 */
  const halve = async (projectId: string, path: string): Promise<void> => {
    try {
      const { size } = await stat(path)
      if (size <= GROUP_FILE_MAX_BYTES) return
      const text = await readFile(path, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      const kept = lines.slice(Math.floor(lines.length / 2))
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, `${kept.join('\n')}\n`, { mode: 0o600 })
      await rename(temp, path)
      logError(new Error(`群組訊息檔超過上限,已裁掉前半:${projectId}`))
    } catch (cause) {
      logError(new Error(`群組訊息檔裁切失敗:${projectId}`, { cause }))
    }
  }

  return {
    async append(message) {
      const name = fileNameOf(message.projectId)
      await serialize(message.projectId, async () => {
        await ensureDir()
        await appendFile(join(dir, name), `${JSON.stringify(message)}\n`, { mode: 0o600 })
      })
    },

    async read(projectId) {
      const path = join(dir, fileNameOf(projectId))
      await ensureDir()
      const size = await stat(path).then((s) => s.size).catch(() => -1)
      if (size < 0) return []
      if (size > GROUP_FILE_MAX_BYTES) await serialize(projectId, () => halve(projectId, path))
      const text = await readFile(path, 'utf8').catch(() => '')
      const messages = decode(text, (count) => {
        logError(new Error(`群組訊息有 ${count} 行無法解析,已跳過:${projectId}`))
      })
      return messages.slice(-GROUP_READ_LIMIT)
    },

    async dispose() {
      await Promise.all([...chains.values()])
      chains = new Map()
    },
  }
}
