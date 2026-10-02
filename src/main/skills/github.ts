export interface GitBlob { path: string; oid: string; size: number; mode: string }
export interface SkillRepository {
  url: string
  ref: string
  prefix: string
  commit: string
  files: readonly GitBlob[]
  read: (file: GitBlob) => Promise<Buffer>
  dispose: () => Promise<void>
}

export function parseSkillUrl(input: string): { url: string; ref: string; prefix: string } {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('請貼上公開 GitHub repository 的 HTTPS 網址') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('僅支援 https://github.com 的公開 repository 網址')
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent)
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/, '')
  if (!/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || repo === '.' || repo === '..') throw new Error('GitHub repository 網址格式不正確')
  if (parts.length !== 2 && (parts[2] !== 'tree' || parts.length < 4)) throw new Error('請使用 repository 或 tree 網址')
  const ref = parts[3] ?? 'HEAD'
  if (!/^[a-zA-Z0-9][\w./-]{0,199}$/.test(ref) || ref.includes('..') || ref.endsWith('/')) throw new Error('Git ref 格式不正確')
  const prefix = parts.slice(4).join('/')
  if (prefix && !safeSkillPath(prefix)) throw new Error('Skill 目錄路徑不正確')
  return { url: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`, ref, prefix }
}

export function safeSkillPath(path: string): boolean {
  return path.length > 0 && path.length <= 500 && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

/** Bounded HTTPS reads at a pinned commit; no git checkout or repository code execution. */
export async function fetchSkillRepository(input: string, request: typeof fetch = fetch): Promise<SkillRepository> {
  const source = parseSkillUrl(input)
  const repository = source.url.slice('https://github.com/'.length)
  const api = `https://api.github.com/repos/${repository}`
  async function download(url: string, limit: number): Promise<Buffer> {
    let response: Response
    try {
      response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'YesChef-Skills', Accept: 'application/vnd.github+json' } })
    } catch { throw new Error('無法連線至 GitHub，請確認網路與公開 repository 網址後重試') }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 暫時限制請求頻率，請稍後重試')
      throw new Error(`GitHub 讀取失敗（${response.status}），請確認公開 repository、版本與路徑`)
    }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('GitHub 回應超過大小限制') }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('GitHub 回應沒有內容')
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new Error('GitHub 回應超過大小限制')
        chunks.push(Buffer.from(value))
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    return Buffer.concat(chunks)
  }
  async function json(url: string): Promise<Record<string, unknown>> {
    const data: unknown = JSON.parse((await download(url, 6 * 1024 * 1024)).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('GitHub 回應格式不正確')
    return data as Record<string, unknown>
  }
  const info = await json(`${api}/commits/${encodeURIComponent(source.ref)}`)
  const commit = info.sha
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('無法確認 repository 版本')
  let treeRef = commit
  for (const part of source.prefix ? source.prefix.split('/') : []) {
    const directory = await json(`${api}/git/trees/${treeRef}`)
    const child = Array.isArray(directory.tree) ? directory.tree.find((entry: Record<string, unknown> | null) => entry && entry.path === part && entry.type === 'tree') : undefined
    if (!child || typeof child.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(child.sha)) throw new Error('找不到指定的 skill 目錄')
    treeRef = child.sha
  }
  const tree = await json(`${api}/git/trees/${treeRef}?recursive=1`)
  if (tree.truncated === true || !Array.isArray(tree.tree) || tree.tree.length > 20_000) throw new Error('Repository 檔案過多，請使用 tree 網址指定較小目錄')
  const files: GitBlob[] = []
  for (const entry of tree.tree) {
    if (!entry || typeof entry !== 'object') throw new Error('GitHub 檔案清單格式不正確')
    if (entry.type === 'tree') continue
    if (typeof entry.path !== 'string' || typeof entry.mode !== 'string' || typeof entry.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(entry.sha)) throw new Error('GitHub 檔案清單格式不正確')
    files.push({ path: source.prefix ? `${source.prefix}/${entry.path}` : entry.path, oid: entry.sha, mode: entry.mode, size: typeof entry.size === 'number' ? entry.size : 0 })
  }
  const cache = new Map<string, Buffer>()
  return { ...source, commit, files,
    read: async file => {
      if (!safeSkillPath(file.path) || !Number.isFinite(file.size) || file.size < 0 || file.size > 2 * 1024 * 1024) throw new Error(`檔案路徑或大小不支援：${file.path}`)
      const cached = cache.get(file.path)
      if (cached) return cached
      const bytes = await download(`https://raw.githubusercontent.com/${repository}/${commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`, 2 * 1024 * 1024)
      if (bytes.byteLength !== file.size) throw new Error(`GitHub 檔案大小與清單不符：${file.path}`)
      const digest = createHash(file.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (digest !== file.oid) throw new Error(`GitHub 檔案內容與版本不符：${file.path}`)
      cache.set(file.path, bytes)
      return bytes
    },
    dispose: async () => { cache.clear() },
  }
}
import { createHash } from 'node:crypto'
