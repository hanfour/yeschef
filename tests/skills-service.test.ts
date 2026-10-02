import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedSkillsService, parseSkillMarkdown, type SharedSkillsService } from '../src/main/skills/service.js'
import { parseSkillUrl, type SkillRepository } from '../src/main/skills/github.js'
import { createSkillsHandler } from '../src/main/skills/ipc.js'

const roots: string[] = []
const services: SharedSkillsService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
const markdown = (name = 'design', description = 'Design interfaces') => `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nRead references/layout.md.`
function repository(entries: Record<string, string> = { 'skills/design/SKILL.md': markdown(), 'skills/design/references/layout.md': 'Keep it readable' }, commit = 'a'.repeat(40)): SkillRepository {
  const files = Object.entries(entries).map(([path, text], index) => ({ path, oid: String(index), size: Buffer.byteLength(text), mode: '100644' }))
  return { url: 'https://github.com/example/skills', prefix: '', ref: 'HEAD', commit, files,
    read: async file => Buffer.from(entries[file.path] ?? ''), dispose: vi.fn(async () => {}) }
}
async function setup(fetcher = async () => repository()) {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-skills-test-')); roots.push(root)
  const service = await createSharedSkillsService(root, fetcher); services.push(service)
  return { root, service }
}
async function install(service: SharedSkillsService, paths = ['skills/design']) {
  const result = await service.handle({ action: 'inspect', url: 'https://github.com/example/skills' })
  if (result.kind !== 'inspection') throw Error(JSON.stringify(result))
  return service.handle({ action: 'install', inspectionId: result.inspection.id, paths })
}

describe('GitHub skill source', () => {
  it('supports repository, .git and scoped tree URLs', () => {
    expect(parseSkillUrl('https://github.com/emilkowalski/skills.git')).toEqual({ url: 'https://github.com/emilkowalski/skills', ref: 'HEAD', prefix: '' })
    expect(parseSkillUrl('https://github.com/EmilKowalski/Skills')).toEqual({ url: 'https://github.com/emilkowalski/skills', ref: 'HEAD', prefix: '' })
    expect(parseSkillUrl('https://github.com/a/b/tree/feature%2Fdesign/skills/design')).toEqual({ url: 'https://github.com/a/b', ref: 'feature/design', prefix: 'skills/design' })
  })
  it.each(['http://github.com/a/b', 'https://evil.test/a/b', 'https://github.com@evil.test/a/b', 'https://a:b@github.com/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b/tree/--upload-pack=x', 'https://github.com/a/b/tree/main/a%2F..%2Fb', 'https://github.com/a/b/blob/main/SKILL.md'])('rejects unsafe or unsupported URL %s', value => {
    expect(() => parseSkillUrl(value)).toThrow()
  })
  it('parses folded YAML descriptions and rejects permission-bearing frontmatter', () => {
    expect(parseSkillMarkdown('---\nname: design\ndescription: >\n  Build polished\n  interfaces.\n---\n# text')).toEqual({ name: 'design', description: 'Build polished interfaces.' })
    expect(() => parseSkillMarkdown('---\nname: ../escape\ndescription: no\n---')).toThrow()
    expect(() => parseSkillMarkdown('---\nname: design\ndescription: ok\nhooks: {}\n---')).toThrow('hooks')
    expect(() => parseSkillMarkdown('---\nname: design\ndescription: ok\nallowed-tools: Bash\n---')).toThrow('allowed-tools')
  })
})

it('installs selected skill resources, persists version and exposes a skills-only plugin plus Codex root', async () => {
  const { root, service } = await setup()
  expect(await install(service)).toMatchObject({ kind: 'state' })
  const skill = service.state().skills[0]!
  expect(skill).toMatchObject({ name: 'design', commit: 'a'.repeat(40), enabled: true, source: { path: 'skills/design' } })
  const runtime = service.runtime()
  const revisionRoot = join(root, 'revisions', service.state().revision!)
  expect(runtime.roots).toEqual([join(revisionRoot, 'codex', 'skills')])
  expect(runtime.plugins).toEqual([{ type: 'local', path: join(revisionRoot, 'claude') }])
  expect(runtime.grokPluginDir).toBe(join(revisionRoot, 'grok'))
  expect(await readFile(join(runtime.roots[0]!, 'design/references/layout.md'), 'utf8')).toBe('Keep it readable')
  expect(await readFile(join(runtime.plugins[0]!.path, 'skills/design/references/layout.md'), 'utf8')).toBe('Keep it readable')
  expect(await readFile(join(runtime.grokPluginDir!, 'skills/design/references/layout.md'), 'utf8')).toBe('Keep it readable')
  expect(JSON.parse(await readFile(join(runtime.plugins[0]!.path, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({ name: 'yeschef-shared', description: 'YesChef 共用 Skills' })
  expect(JSON.parse(await readFile(join(runtime.grokPluginDir!, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({ name: 'yeschef-shared', description: 'YesChef 共用 Skills' })
  expect((await readdir(revisionRoot)).sort()).toEqual(['claude', 'codex', 'grok'])
  expect((await readdir(runtime.plugins[0]!.path)).sort()).toEqual(['.claude-plugin', 'skills'])
  expect((await readdir(join(revisionRoot, 'codex'))).sort()).toEqual(['skills'])
  expect((await readdir(runtime.grokPluginDir!)).sort()).toEqual(['.claude-plugin', 'skills'])
  const restored = await createSharedSkillsService(root); services.push(restored)
  expect(restored.state()).toEqual(service.state())
  expect(restored.runtime()).toEqual(runtime)
})

it('writes provider-specific markdown into immutable snapshots and leaves package sources unchanged', async () => {
  const template = `${markdown()}\n{{provider}} {{skill_prefix}} {{shell_tool}} {{skill_dir}}`
  const { root, service } = await setup(async () => repository({
    'skills/design/SKILL.md': template,
    'skills/design/references/guide.md': '{{provider}} {{skill_dir}}',
    'skills/design/scripts/run.sh': '{{provider}}',
  }))
  await install(service)
  const skill = service.state().skills[0]!
  const revisionRoot = join(root, 'revisions', service.state().revision!)
  const variants = [
    ['claude', 'claude / Bash', 'claude'],
    ['codex', 'codex $ shell', 'codex'],
    ['grok', 'grok / run_terminal_command', 'grok'],
  ] as const

  for (const [provider, values, dirname] of variants) {
    const skillDir = join(revisionRoot, dirname, 'skills', 'design')
    const actual = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    expect(actual).toContain(`${values} ${skillDir}`)
    expect(await readFile(join(skillDir, 'references/guide.md'), 'utf8')).toBe(`${provider} ${skillDir}`)
    expect(await readFile(join(skillDir, 'scripts/run.sh'), 'utf8')).toBe('{{provider}}')
  }
  expect(await readFile(join(root, 'packages', skill.id, skill.commit, 'SKILL.md'), 'utf8')).toBe(template)
})

it('preview reports unknown variables from markdown files by candidate', async () => {
  const { service } = await setup(async () => repository({
    'skills/design/SKILL.md': `${markdown()}\nUse {{tool_name}}.`,
    'skills/design/references/tooling.md': 'Run {{shell_tool}} through {{shellTool}}.',
    'skills/design/scripts/run.sh': 'Use {{not_a_variable}}.',
  }))
  const preview = await service.handle({ action: 'inspect', url: 'https://github.com/example/skills' })
  if (preview.kind !== 'inspection') throw Error('expected inspection')
  expect(preview.inspection.candidates[0]?.variableWarnings).toEqual([
    'SKILL.md：未知變數 {{tool_name}}，安裝後會原樣保留',
    'references/tooling.md：未知變數 {{shellTool}}，安裝後會原樣保留',
  ])
})

it('uses legacy snapshot paths when the old root plugin directory exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-legacy-skills-')); roots.push(root)
  const revision = '20000000-0000-4000-8000-000000000002'
  const revisionRoot = join(root, 'revisions', revision)
  await mkdir(join(revisionRoot, '.claude-plugin'), { recursive: true })
  await mkdir(join(revisionRoot, 'skills', 'design'), { recursive: true })
  await writeFile(join(revisionRoot, '.claude-plugin', 'plugin.json'), '{}')
  await writeFile(join(root, 'index.json'), JSON.stringify({
    revision,
    skills: [{
      id: '10000000-0000-4000-8000-000000000001', name: 'design', description: 'Design interfaces',
      source: { url: 'https://github.com/example/skills', ref: 'HEAD', path: 'skills/design' },
      commit: 'a'.repeat(40), enabled: true, installedAt: '2026-10-02T00:00:00.000Z',
    }],
  }))
  const service = await createSharedSkillsService(root); services.push(service)

  expect(service.runtime()).toEqual({
    roots: [join(revisionRoot, 'skills')],
    plugins: [{ type: 'local', path: revisionRoot }],
  })
  const id = service.state().skills[0]!.id
  expect(await service.handle({ action: 'enable', id, enabled: false })).toMatchObject({ kind: 'state' })
  const nextRevision = join(root, 'revisions', service.state().revision!)
  expect((await readdir(nextRevision)).sort()).toEqual(['claude', 'codex', 'grok'])
  expect((await readdir(join(nextRevision, 'codex'))).sort()).toEqual(['skills'])
})

it('updates atomically while active snapshots retain the original version; disable/remove affect new sessions', async () => {
  let remote = repository()
  const { service } = await setup(async () => remote)
  await install(service)
  const firstRoot = service.runtime().roots[0]!
  const id = service.state().skills[0]!.id
  remote = repository({ 'skills/design/SKILL.md': markdown(), 'skills/design/references/layout.md': 'New version' }, 'b'.repeat(40))
  await install(service)
  expect(service.state().skills[0]!.id).toBe(id)
  expect(await readFile(join(firstRoot, 'design/references/layout.md'), 'utf8')).toBe('Keep it readable')
  expect(await readFile(join(service.runtime().roots[0]!, 'design/references/layout.md'), 'utf8')).toBe('New version')
  await service.handle({ action: 'enable', id, enabled: false })
  expect(service.runtime()).toEqual({ roots: [], plugins: [] })
  await service.handle({ action: 'enable', id, enabled: true })
  expect(service.runtime().roots).toHaveLength(1)
  await service.handle({ action: 'remove', id })
  expect(service.state().skills).toEqual([])
  expect(await readFile(join(firstRoot, 'design/SKILL.md'), 'utf8')).toContain('Instructions')
})

it('failed updates leave both catalog and original files untouched', async () => {
  let remote = repository()
  const { root, service } = await setup(async () => remote)
  await install(service)
  const before = service.state()
  remote = repository({ 'skills/design/SKILL.md': markdown(), 'skills/design/references/layout.md': 'bad' }, 'b'.repeat(40))
  const read = remote.read
  remote.read = async file => { if (file.path.endsWith('layout.md')) throw Error('connection lost'); return read(file) }
  expect(await install(service)).toEqual({ kind: 'error', message: 'connection lost' })
  expect(service.state()).toEqual(before)
  expect(JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))).toEqual(before)
})

it.each(['symlink', 'traversal', 'case collision', 'nested skill', 'oversized'])('rejects %s without publishing a partial install', async kind => {
  const remote = repository()
  const extra = { path: 'skills/design/ref', mode: '100644', oid: 'extra', size: 1 }
  if (kind === 'symlink') extra.mode = '120000'
  if (kind === 'traversal') extra.path = 'skills/design/../../escape'
  if (kind === 'case collision') extra.path = 'skills/design/skill.md'
  if (kind === 'nested skill') extra.path = 'skills/design/child/SKILL.md'
  if (kind === 'oversized') extra.size = 11 * 1024 * 1024
  remote.files = [...remote.files, extra]
  const { service } = await setup(async () => remote)
  expect(await install(service)).toMatchObject({ kind: 'error' })
  expect(service.state().skills).toEqual([])
})

it('same name from another repository cannot overwrite the installed skill', async () => {
  let remote = repository()
  const { service } = await setup(async () => remote)
  await install(service)
  const before = service.state()
  remote = { ...repository(), url: 'https://github.com/another/skills' }
  expect(await install(service)).toMatchObject({ kind: 'error', message: expect.stringContaining('同名') })
  expect(service.state()).toEqual(before)
})

it('invalid candidates are reported, expired/tampered selections are rejected, and concurrent mutations serialize', async () => {
  const { service } = await setup(async () => repository({ 'skills/design/SKILL.md': markdown(), 'skills/bad/SKILL.md': 'bad' }))
  const preview = await service.handle({ action: 'inspect', url: 'https://github.com/example/skills' })
  if (preview.kind !== 'inspection') throw Error('expected inspection')
  expect(preview.inspection.candidates).toHaveLength(1)
  expect(preview.inspection.warnings).toHaveLength(1)
  expect(await service.handle({ action: 'install', inspectionId: preview.inspection.id, paths: ['../../x'] })).toMatchObject({ kind: 'error' })
  await service.handle({ action: 'install', inspectionId: preview.inspection.id, paths: ['skills/design'] })
  expect(await service.handle({ action: 'install', inspectionId: preview.inspection.id, paths: ['skills/design'] })).toMatchObject({ kind: 'error' })
  const id = service.state().skills[0]!.id
  await Promise.all([service.handle({ action: 'enable', id, enabled: false }), service.handle({ action: 'remove', id })])
  expect(service.state().skills).toEqual([])
})

it('corrupt saved state is surfaced rather than overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-bad-skills-')); roots.push(root)
  await writeFile(join(root, 'index.json'), '{invalid')
  await expect(createSharedSkillsService(root)).rejects.toThrow()
  expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('{invalid')
})

it('IPC rejects foreign senders and malformed payloads before performing any operation', async () => {
  const handle = vi.fn(async () => ({ kind: 'state' as const, state: { revision: null, skills: [] } }))
  const handler = createSkillsHandler({ handle }, sender => sender === 'renderer')
  expect(await handler({ sender: 'browser' }, { action: 'list' })).toMatchObject({ kind: 'error' })
  expect(await handler({ sender: 'renderer' }, { action: 'install', inspectionId: '../x', paths: [] })).toMatchObject({ kind: 'error' })
  expect(handle).not.toHaveBeenCalled()
  expect(await handler({ sender: 'renderer' }, { action: 'list', ignored: 'extra' })).toMatchObject({ kind: 'state' })
  expect(handle).toHaveBeenCalledWith({ action: 'list' })
})
