import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, lstat, readlink, mkdtemp, rm, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import type { DiffFile, DiffResult, DiffRepositories } from '../shared/conversation-tools.js'
const exec = promisify(execFile)
const FILE_LIMIT = 512 * 1024, TOTAL_LIMIT = 4 * 1024 * 1024, COUNT_LIMIT = 200
interface Version { data: string | null; omitted?: boolean; mode?: number; binary?: boolean; fingerprint?: string }
interface Snapshot { version: 1; root: string; head: string | null; createdAt: string; dirty: Record<string, Version>; warnings: string[] }
async function git(root: string, args: string[]): Promise<Buffer> {
  const { stdout } = await exec('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'buffer', maxBuffer: TOTAL_LIMIT, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  return stdout
}
async function head(root: string): Promise<string | null> {
  try { return (await git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim() } catch { return null }
}
async function files(root: string, base: string | null): Promise<string[]> {
  const tracked = base ? await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--']) : await git(root, ['ls-files', '-z'])
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  return [...new Set([...tracked.toString().split('\0'), ...untracked.toString().split('\0')].filter(Boolean))].sort()
}
async function version(root: string, path: string): Promise<Version> {
  const full = resolve(root, path), rel = relative(root, full)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error('diff 路徑超出專案')
  try {
    let parent = dirname(full)
    while (parent !== root) {
      if ((await lstat(parent)).isSymbolicLink()) return { data: null, omitted: true }
      const next = dirname(parent); if (next === parent) throw Error('diff 路徑不合法'); parent = next
    }
    const info = await lstat(full)
    if (info.isSymbolicLink()) return { data: Buffer.from(await readlink(full)).toString('base64'), mode: 0o120000 }
    if (!info.isFile() || info.size > FILE_LIMIT) return { data: null, omitted: true }
    const bytes = await readFile(full)
    if (bytes.length > FILE_LIMIT) return { data: null, omitted: true }
    const mode = info.mode & 0o111 ? 0o100755 : 0o100644
    return bytes.includes(0) ? { data: null, mode, binary: true, fingerprint: createHash('sha256').update(bytes).digest('hex') } : { data: bytes.toString('base64'), mode }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: null }; throw error }
}
async function committed(root: string, commit: string | null, path: string): Promise<Version> {
  if (!commit) return { data: null }
  let entry: string
  try { entry = (await git(root, ['ls-tree', '-z', commit, '--', path])).toString() } catch { return { data: null, omitted: true } }
  if (!entry) return { data: null }
  const [mode, type, object] = entry.split('\t')[0]!.split(' ')
  if (type !== 'blob' || !object) return { data: null, omitted: true }
  try {
    const size = Number((await git(root, ['cat-file', '-s', object])).toString())
    if (size > FILE_LIMIT) return { data: null, omitted: true }
    return { data: (await git(root, ['cat-file', 'blob', object])).toString('base64'), mode: parseInt(mode!, 8) }
  } catch { return { data: null, omitted: true } }
}
async function patch(path: string, old: Version, current: Version): Promise<DiffFile | null> {
  const status = old.data === null && !old.binary ? 'added' : current.data === null && !current.binary ? 'deleted' : 'modified'
  if (old.omitted || current.omitted) return { path, status: 'modified', patch: '檔案過大、子模組或基準無法讀取，未呈現內容。', binary: false, omitted: true }
  const a = Buffer.from(old.data ?? '', 'base64'), b = Buffer.from(current.data ?? '', 'base64')
  if (old.binary || current.binary || a.includes(0) || b.includes(0)) {
    const before = old.fingerprint ?? (old.data === null ? null : createHash('sha256').update(a).digest('hex'))
    const after = current.fingerprint ?? (current.data === null ? null : createHash('sha256').update(b).digest('hex'))
    return before === after && old.mode === current.mode ? null : { path, status, patch: '二進位檔案已變更', binary: true, omitted: false }
  }
  if (old.data === current.data && old.mode === current.mode) return null
  const dir = await mkdtemp(join(tmpdir(), 'yeschef-diff-'))
  try {
    await writeFile(join(dir, 'before'), a); await writeFile(join(dir, 'after'), b)
    let output: string
    try { output = (await git(dir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'before', 'after'])).toString() }
    catch (error) {
      const e = error as { code?: number; stdout?: Buffer }
      if (e.code !== 1 || !e.stdout) throw error
      output = e.stdout.toString()
    }
    output = output.replace(/^diff --git .+\n/, '').replace(/^index .+\n/m, '').replace(/^--- .+$/m, `--- ${old.data === null ? '/dev/null' : JSON.stringify(path)}`).replace(/^\+\+\+ .+$/m, `+++ ${current.data === null ? '/dev/null' : JSON.stringify(path)}`)
    if (!output && old.data === null) output = '新增空檔案'
    if (!output && current.data === null) output = '刪除空檔案'
    if (old.mode !== current.mode && old.data !== null && current.data !== null) output = `mode ${old.mode?.toString(8)} → ${current.mode?.toString(8)}\n${output}`
    return { path, status, patch: output.slice(0, FILE_LIMIT), binary: false, omitted: output.length > FILE_LIMIT }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
function createSingleRepositoryDiff(dir: string) {
  const captures = new Map<string, Promise<void>>()
  const filename = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  const rootOf = async (cwd: string) => {
    try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).toString().trim() }
    catch { throw Error('此工作目錄不是可讀取的 Git repository，無法顯示 diff。') }
  }
  async function load(key: string, root: string): Promise<Snapshot | null> {
    try {
      const value = JSON.parse(await readFile(filename(key), 'utf8')) as Snapshot
      if (value.version !== 1 || value.root !== root || (value.head !== null && !/^[a-f0-9]{40,64}$/.test(value.head))) throw Error('diff 基準格式不正確')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  return {
    capture(key: string, cwd: string): Promise<void> {
      const existing = captures.get(key); if (existing) return existing
      const task = (async () => {
        const root = await rootOf(cwd); if (await load(key, root)) return
        const base = await head(root), names = await files(root, base)
        const dirty: Record<string, Version> = Object.create(null), warnings: string[] = []
        if (names.length > COUNT_LIMIT) throw Error('初始變更超過 200 個檔案，無法建立完整對話基準')
        let size = 0
        for (const path of names) { const v = await version(root, path); size += v.data?.length ?? 0; dirty[path] = size > TOTAL_LIMIT ? { data: null, omitted: true } : v }
        if (size > TOTAL_LIMIT) warnings.push('初始變更超過基準容量，部分檔案只能顯示未擷取提示。')
        const snapshot: Snapshot = { version: 1, root, head: base, createdAt: new Date().toISOString(), dirty, warnings }
        await mkdir(dir, { recursive: true, mode: 0o700 }); const temp = `${filename(key)}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 }); await rename(temp, filename(key))
      })()
      captures.set(key, task)
      void task.catch(() => { captures.delete(key) })
      return task
    },
    async changedFiles(key: string, cwd: string): Promise<DevelopmentFile[]> {
      const root = await rootOf(cwd), snapshot = await load(key, root)
      if (!snapshot) throw Error('此對話尚無開發基準')
      const names = [...new Set([...await files(root, snapshot.head), ...Object.keys(snapshot.dirty)])]
        .filter((path) => /\.(css|scss|tsx|jsx|vue|svelte|html)$/i.test(path))
        .sort()
      if (names.length > COUNT_LIMIT) throw Error('介面檔案變更超過 200 個，無法完整掃描')
      const changed: DevelopmentFile[] = []
      let size = 0
      for (const path of names) {
        const before = Object.hasOwn(snapshot.dirty, path) ? snapshot.dirty[path]! : await committed(root, snapshot.head, path)
        const current = await version(root, path)
        const same = before.data === current.data && before.mode === current.mode && before.fingerprint === current.fingerprint
        if (same || current.data === null || current.omitted || current.binary || current.mode === 0o120000) continue
        const bytes = Buffer.from(current.data, 'base64')
        size += bytes.length
        if (size > TOTAL_LIMIT) throw Error('介面檔案內容超過 4 MiB，無法完整掃描')
        changed.push({ path, text: bytes.toString('utf8') })
      }
      return changed
    },
    async read(key: string, cwd: string, scope: 'conversation' | 'working' | 'base', baseRef?: string): Promise<DiffResult> {
      const root = await rootOf(cwd)
      const snapshot = scope === 'conversation' ? await load(key, root) : null
      if (scope === 'conversation' && !snapshot) throw Error('此對話尚無開發基準。下一次送出訊息前會自動建立；目前可先查看「未提交變更」。')
      let base = snapshot ? snapshot.head : await head(root)
      if (scope === 'base') {
        if (!baseRef?.trim() || baseRef.length > 256 || baseRef.includes('\0')) throw Error('請輸入 commit 或分支作為比較基準')
        try { base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${baseRef.trim()}^{commit}`])).toString().trim() }
        catch { throw Error('找不到這個 commit／分支，請確認比較基準') }
        if (!/^[a-f0-9]{40,64}$/.test(base)) throw Error('比較基準無效')
      }
      const names = [...new Set([...await files(root, base), ...Object.keys(snapshot?.dirty ?? {})])].sort()
      const warnings = [...(snapshot?.warnings ?? []), '此範圍呈現工作目錄的變化；共用目錄中其他人的變更也可能包含在內。']
      if (names.length > COUNT_LIMIT) warnings.push('變更超過 200 個檔案，只顯示前 200 個。')
      const results: DiffFile[] = []; let size = 0
      for (const path of names.slice(0, COUNT_LIMIT)) {
        const before = snapshot && Object.hasOwn(snapshot.dirty, path) ? snapshot.dirty[path]! : await committed(root, base, path)
        const result = await patch(path, before, await version(root, path)); if (!result) continue
        size += result.patch.length
        if (size > TOTAL_LIMIT) { warnings.push('diff 超過 4 MiB，後續內容已省略。'); break }
        results.push(result)
      }
      return { kind: 'diff', files: results, scope, baseline: snapshot ? `對話基準 ${snapshot.createdAt}（${base?.slice(0, 8) ?? '尚無 commit'}）` : scope === 'base' ? `基準 ${baseRef}（${base?.slice(0, 8)}）→目前工作目錄` : `目前 HEAD ${base?.slice(0, 8) ?? '尚無 commit'}`, warnings }
    },
  }
}


interface Repository { id: string; label: string; root: string; primary: boolean }
export interface DevelopmentFile { readonly path: string; readonly text: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
/** Bounded discovery; never traverse symlinks or dependency/output trees. */
async function discover(cwd: string): Promise<{ repositories: Repository[]; warnings: string[] }> {
  const workspace = await realpath(cwd)
  const repositories: Repository[] = [], warnings: string[] = []
  const seen = new Set<string>()
  const add = (root: string, primary: boolean) => {
    if (seen.has(root)) return
    seen.add(root); repositories.push({ id: digest(root), label: relative(workspace, root) || basename(root), root, primary })
  }
  try { add(await realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).toString().trim()), true) } catch { /* parent workspace may not be a repo */ }
  const queue = [{ path: workspace, depth: 0 }]
  const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', 'Pods', '__pycache__'])
  let visited = 0
  while (queue.length && visited < 1000 && repositories.length < 50) {
    const entry = queue.shift()!; visited += 1
    let entries
    try { entries = await readdir(entry.path, { withFileTypes: true }) }
    catch { warnings.push(`無法掃描 ${relative(workspace, entry.path) || '.'}`); continue }
    const marker = entries.find(e => e.name === '.git' && !e.isSymbolicLink())
    if (entry.depth > 0 && marker) {
      try {
        const root = await realpath((await git(entry.path, ['rev-parse', '--show-toplevel'])).toString().trim())
        if (root === entry.path) { add(root, false); continue }
      } catch { warnings.push(`無法讀取 Git repository：${relative(workspace, entry.path)}`) }
    }
    const children = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !excluded.has(e.name)).sort((a,b) => a.name.localeCompare(b.name))
    if (entry.depth >= 3) { if (children.length) warnings.push('掃描深度上限為 3 層；更深的 repo 請另外加入專案。'); continue }
    for (const child of children) queue.push({ path: join(entry.path, child.name), depth: entry.depth + 1 })
  }
  if (queue.length) warnings.push('已達掃描上限（1000 個目錄／50 個 repo），部分項目未列出。')
  return { repositories: repositories.sort((a,b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label)), warnings: [...new Set(warnings)] }
}
/** Resolve removed files using their nearest surviving ancestor; symlink targets stay authoritative. */
async function canonicalChangedPath(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  let ancestor = path
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)) }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null }
    const parent = dirname(ancestor); if (parent === ancestor) return null; ancestor = parent
  }
}
async function modifiedRepositories(repositories: Repository[], paths: readonly string[]): Promise<Repository[]> {
  const roots = new Set<string>()
  const sorted = [...repositories].sort((a,b) => b.root.length - a.root.length)
  for (const path of new Set(paths)) {
    const canonical = await canonicalChangedPath(path); if (!canonical) continue
    const owner = sorted.find(repo => { const rel = relative(repo.root, canonical); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) })
    if (owner) roots.add(owner.root)
  }
  return repositories.filter(repo => roots.has(repo.root))
}
export function createDevelopmentDiff(dir: string) {
  const single = createSingleRepositoryDiff(dir)
  const pending = new Map<string, Promise<void>>()
  const manifestPath = (key: string) => join(dir, `${digest(key)}.repositories.json`)
  const repoKey = (key: string, repo: Repository) => repo.primary ? key : JSON.stringify([key, repo.root])
  async function manifest(key: string): Promise<{ roots: string[]; errors: Record<string, string> } | null> {
    try {
      const value = JSON.parse(await readFile(manifestPath(key), 'utf8'))
      if (!Array.isArray(value.roots) || !value.roots.every((r: unknown) => typeof r === 'string') || typeof value.errors !== 'object' || value.errors === null) throw Error('repo 基準清單損壞')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  return {
    async repositories(cwd: string, changedPaths: readonly string[] = []): Promise<DiffRepositories> {
      const result = await discover(cwd)
      const matched = await modifiedRepositories(result.repositories, changedPaths)
      return { kind: 'repositories', repositories: matched.map(({ id, label }) => ({ id, label })), warnings: result.warnings }
    },
    capture(key: string, cwd: string): Promise<void> {
      const task = pending.get(key); if (task) return task
      const next = (async () => {
        if (await manifest(key)) return
        const found = await discover(cwd)
        if (!found.repositories.length) throw Error('此專案與子目錄中沒有可讀取的 Git repository')
        const errors: Record<string, string> = Object.create(null)
        // Capture each repo independently; one oversized or unavailable repo cannot hide the others.
        for (const repo of found.repositories) {
          try { await single.capture(repoKey(key, repo), repo.root) }
          catch (error) { errors[repo.root] = error instanceof Error ? error.message : '建立基準失敗' }
        }
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const temp = `${manifestPath(key)}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify({ roots: found.repositories.map(r => r.root), errors }), { mode: 0o600 })
        await rename(temp, manifestPath(key))
        if (Object.keys(errors).length) throw Error(`部分 repo 無法建立基準：${Object.keys(errors).map(r => basename(r)).join('、')}`)
      })()
      pending.set(key, next); void next.catch(() => { pending.delete(key) }); return next
    },
    async changedFiles(key: string, cwd: string): Promise<DevelopmentFile[]> {
      const captured = await manifest(key)
      if (!captured) throw Error('此對話尚無開發基準')
      const found = await discover(cwd), changed: DevelopmentFile[] = []
      for (const root of captured.roots) {
        const repo = found.repositories.find((candidate) => candidate.root === root)
        if (!repo) continue
        if (captured.errors[root]) throw Error(`此 repo 未建立基準：${captured.errors[root]}`)
        const files = await single.changedFiles(repoKey(key, repo), repo.root)
        changed.push(...files.map((file) => ({ path: repo.primary ? file.path : `${repo.label}/${file.path}`, text: file.text })))
      }
      return changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    },
    async read(key: string, cwd: string, scope: 'conversation' | 'working' | 'base', repositoryId?: string, baseRef?: string, changedPaths?: readonly string[]): Promise<DiffResult> {
      const found = await discover(cwd)
      if (!found.repositories.length) throw Error('此專案與子目錄中沒有可讀取的 Git repository')
      const repo = repositoryId ? found.repositories.find(r => r.id === repositoryId) : found.repositories.length === 1 ? found.repositories[0] : found.repositories.find(r => r.primary)
      if (!repo) throw Error(repositoryId ? '選取的 repo 已不存在或不在專案範圍內' : '請先選擇要查看的 Git repository')
      if (changedPaths !== undefined && !(await modifiedRepositories(found.repositories, changedPaths)).some(match => match.id === repo.id)) throw Error('此 repo 沒有本次對話成功寫入的紀錄')
      if (scope === 'conversation') {
        const captured = await manifest(key)
        if (captured && !captured.roots.includes(repo.root)) throw Error('此 repo 在對話基準建立後才被找到，不能推算先前變更；請查看未提交變更或指定比較基準。')
        if (captured?.errors[repo.root]) throw Error(`此 repo 未建立基準：${captured.errors[repo.root]}。可改看未提交變更或指定基準。`)
      }
      const result = await single.read(repoKey(key, repo), repo.root, scope, baseRef)
      return { ...result, baseline: `${repo.label} · ${result.baseline}`, warnings: [...found.warnings, ...result.warnings] }
    },
  }
}
export type DevelopmentDiff = ReturnType<typeof createDevelopmentDiff>
