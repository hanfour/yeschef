import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, cp, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { SkillName, SkillsStateSchema, type SkillsState, type InstalledSkill, type SkillCandidate, type SkillInspection, type SkillsRequest, type SkillsResponse } from '../../shared/skills.js'
import { fetchSkillRepository, safeSkillPath, type SkillRepository } from './github.js'

export function parseSkillMarkdown(markdown: string): { name: string; description: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) throw new Error('SKILL.md 缺少 YAML name／description')
  const data: unknown = parseYaml(match[1]!, { maxAliasCount: 20 })
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('SKILL.md frontmatter 格式不正確')
  const meta = data as Record<string, unknown>
  const parsedName = SkillName.safeParse(meta.name)
  if (!parsedName.success) throw new Error('Skill name 須為 1–64 字小寫英數字或連字號，並以英數字開頭')
  const name = parsedName.data
  if (typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 3000) throw new Error('Skill description 必須是 1–3000 字文字')
  if ('hooks' in meta || 'allowed-tools' in meta || '<<' in meta) throw new Error('暫不支援包含 hooks／allowed-tools／YAML 合併的 skill，以保留工作台批准流程')
  return { name, description: meta.description.trim() }
}

interface Preview { inspection: SkillInspection; repository: SkillRepository; createdAt: number }
export interface SharedSkillsService {
  state(): SkillsState
  runtime(): { roots: string[]; plugins: { type: 'local'; path: string }[] }
  handle(request: SkillsRequest): Promise<SkillsResponse>
  dispose(): Promise<void>
}

/** Immutable revisions keep active conversations on the files they originally loaded. */
export async function createSharedSkillsService(root: string, fetchRepository = fetchSkillRepository): Promise<SharedSkillsService> {
  await mkdir(root, { recursive: true })
  const index = join(root, 'index.json')
  let state: SkillsState = { revision: null, skills: [] }
  try {
    state = SkillsStateSchema.parse(JSON.parse(await readFile(index, 'utf8')))
    if (state.revision && !(await lstat(join(root, 'revisions', state.revision, 'skills'))).isDirectory()) throw new Error('共用 Skills 版本資料遺失')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    // An index that points to missing files must not silently become an empty catalog.
    try { await lstat(index); throw new Error('共用 Skills 版本資料遺失') } catch (check) {
      if (!(check instanceof Error && 'code' in check && check.code === 'ENOENT')) throw check
    }
  }
  const previews = new Map<string, Preview>()
  let pending = Promise.resolve()
  let closed = false
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation)
    pending = next.then(() => {}, () => {})
    return next
  }
  const prune = async () => {
    for (const [id, preview] of previews) {
      if (Date.now() - preview.createdAt > 15 * 60_000 || previews.size >= 3) {
        previews.delete(id)
        await preview.repository.dispose()
      }
    }
  }
  const inspect = async (url: string): Promise<SkillInspection> => {
    await prune()
    const repository = await fetchRepository(url)
    try {
      const candidates: SkillCandidate[] = []
      const warnings: string[] = []
      const skills = repository.files.filter(file => (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
        && (!repository.prefix || file.path === `${repository.prefix}/SKILL.md` || file.path.startsWith(`${repository.prefix}/`)))
      if (skills.length > 100) throw new Error('Skills 超過 100 個，請使用 tree 網址指定目錄')
      for (const file of skills) {
        const path = file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length)
        try {
          if (!safeSkillPath(file.path) || file.mode !== '100644' && file.mode !== '100755' || file.size > 256 * 1024) throw new Error('SKILL.md 必須是 256KB 內的一般檔案')
          const markdown = (await repository.read(file)).toString('utf8')
          candidates.push({ path, ...parseSkillMarkdown(markdown), markdown })
        } catch (error) { warnings.push(`${file.path}：${error instanceof Error ? error.message : '格式不支援'}`) }
      }
      const inspection: SkillInspection = { id: randomUUID(), url: repository.url, ref: repository.ref, commit: repository.commit, candidates, warnings }
      previews.set(inspection.id, { inspection, repository, createdAt: Date.now() })
      return inspection
    } catch (error) { await repository.dispose(); throw error }
  }
  const publish = async (skills: InstalledSkill[]) => {
    const revision = randomUUID()
    const target = join(root, 'revisions', revision)
    const temporaryIndex = join(root, `${revision}.json.tmp`)
    try {
      await mkdir(join(target, 'skills'), { recursive: true })
      await mkdir(join(target, '.claude-plugin'))
      await writeFile(join(target, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'yeschef-shared', description: 'YesChef 共用 Skills' }))
      for (const skill of skills.filter(skill => skill.enabled)) {
        await cp(join(root, 'packages', skill.id, skill.commit), join(target, 'skills', skill.name), { recursive: true, errorOnExist: true, force: false })
      }
      const next = { revision, skills }
      await writeFile(temporaryIndex, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(temporaryIndex, index)
      state = next
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      await rm(temporaryIndex, { force: true })
      throw error
    }
  }
  const install = async (inspectionId: string, paths: string[]) => {
    const preview = previews.get(inspectionId)
    if (!preview || Date.now() - preview.createdAt > 15 * 60_000) throw new Error('預覽已過期，請重新讀取 GitHub repository')
    const { repository, inspection } = preview
    const selected = [...new Set(paths)].map(path => {
      const candidate = inspection.candidates.find(candidate => candidate.path === path)
      if (!candidate) throw new Error('所選 skill 不在已讀取的清單內')
      return candidate
    })
    const next = [...state.skills]
    const created: string[] = []
    let total = 0
    try {
      for (const candidate of selected) {
        const existing = next.find(skill => skill.name === candidate.name)
        if (existing && (existing.source.url !== inspection.url || existing.source.path !== candidate.path)) throw new Error(`同名 skill 已來自其他來源：${candidate.name}`)
        const skill: InstalledSkill = {
          id: existing?.id ?? randomUUID(), name: candidate.name, description: candidate.description,
          source: { url: inspection.url, ref: inspection.ref, path: candidate.path }, commit: inspection.commit,
          enabled: existing?.enabled ?? true, installedAt: new Date().toISOString(),
        }
        const packagePath = join(root, 'packages', skill.id, skill.commit)
        const files = repository.files.filter(file => !candidate.path || file.path.startsWith(`${candidate.path}/`))
        if (files.length > 1000 || files.reduce((n, file) => n + file.size, 0) > 10 * 1024 * 1024) throw new Error(`Skill 超過 1000 檔或 10MB：${skill.name}`)
        const seen = new Set<string>()
        for (const file of files) {
          if (!safeSkillPath(file.path) || !['100644', '100755'].includes(file.mode)) throw new Error(`Skill 不支援符號連結、子模組或特殊路徑：${file.path}`)
          const relative = candidate.path ? file.path.slice(candidate.path.length + 1) : file.path
          const canonical = relative.normalize('NFC').toLowerCase()
          if (seen.has(canonical)) throw new Error(`檔案名稱大小寫衝突：${file.path}`)
          seen.add(canonical)
          if (canonical.endsWith('/skill.md') || canonical === 'skill.md' && relative !== 'SKILL.md') throw new Error('請分別選取個別 skill，不能安裝含其他 SKILL.md 的父目錄')
          total += file.size
        }
        if (!Number.isFinite(total) || total > 40 * 1024 * 1024) throw new Error('所選 Skills 超過 40MB')
        let exists = false
        try { await lstat(packagePath); exists = true } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (!exists) {
          await mkdir(packagePath, { recursive: true })
          created.push(packagePath)
          for (const file of files) {
            const relative = candidate.path ? file.path.slice(candidate.path.length + 1) : file.path
            const out = join(packagePath, relative)
            await mkdir(join(out, '..'), { recursive: true })
            await writeFile(out, await repository.read(file), { mode: file.mode === '100755' ? 0o700 : 0o600 })
          }
        }
        if (existing) next[next.indexOf(existing)] = skill
        else next.push(skill)
      }
      await publish(next)
    } catch (error) { for (const dir of created) await rm(dir, { recursive: true, force: true }); throw error }
    previews.delete(inspectionId)
    await repository.dispose()
  }
  return {
    state: () => structuredClone(state),
    runtime: () => {
      if (!state.revision || !state.skills.some(skill => skill.enabled)) return { roots: [], plugins: [] }
      const path = join(root, 'revisions', state.revision)
      return { roots: [join(path, 'skills')], plugins: [{ type: 'local', path }] }
    },
    handle: request => serialize(async () => {
      if (closed) return { kind: 'error', message: 'Skills 管理已關閉' }
      try {
        if (request.action === 'inspect') return { kind: 'inspection', inspection: await inspect(request.url) }
        if (request.action === 'install') await install(request.inspectionId, request.paths)
        if (request.action === 'enable' || request.action === 'remove') {
          if (!state.skills.some(skill => skill.id === request.id)) throw new Error('找不到已安裝的 skill，請重新整理')
          await publish(request.action === 'remove' ? state.skills.filter(skill => skill.id !== request.id)
            : state.skills.map(skill => skill.id === request.id ? { ...skill, enabled: request.enabled } : skill))
        }
        return { kind: 'state', state: structuredClone(state) }
      } catch (error) { return { kind: 'error', message: error instanceof Error ? error.message : 'Skills 操作失敗，請重試' } }
    }),
    dispose: () => serialize(async () => { closed = true; for (const preview of previews.values()) await preview.repository.dispose(); previews.clear() }),
  }
}
