import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { InstalledSkill } from '../../shared/skills.js'
import { replaceSkillVariables, type SkillFile, type SkillProvider } from './variables.js'

const PROVIDERS: readonly SkillProvider[] = ['claude', 'codex', 'grok']
const PLUGIN_CONFIG = JSON.stringify({ name: 'yeschef-shared', description: 'YesChef 共用 Skills' })

export type SnapshotLayout = 'legacy' | 'providers'

export async function detectSnapshotLayout(revisionRoot: string): Promise<SnapshotLayout> {
  try {
    await lstat(join(revisionRoot, '.claude-plugin'))
    return 'legacy'
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    return 'providers'
  }
}

export async function createSkillSnapshot(root: string, revision: string, skills: readonly InstalledSkill[]): Promise<void> {
  const revisionRoot = join(root, 'revisions', revision)
  for (const provider of PROVIDERS) await mkdir(join(revisionRoot, provider, 'skills'), { recursive: true })
  for (const provider of ['claude', 'grok'] as const) {
    const pluginDir = join(revisionRoot, provider, '.claude-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'plugin.json'), PLUGIN_CONFIG)
  }
  for (const skill of skills.filter(item => item.enabled)) {
    await copySkillForProviders(root, revisionRoot, skill)
  }
}

async function copySkillForProviders(root: string, revisionRoot: string, skill: InstalledSkill): Promise<void> {
  const sourceDir = join(root, 'packages', skill.id, skill.commit)
  const files = await readSkillFiles(sourceDir)
  for (const provider of PROVIDERS) {
    const targetDir = resolve(revisionRoot, provider, 'skills', skill.name)
    await cp(sourceDir, targetDir, { recursive: true, errorOnExist: true, force: false })
    const result = replaceSkillVariables(files, provider, targetDir)
    for (let index = 0; index < result.files.length; index++) {
      const original = files[index]!
      const rendered = result.files[index]!
      if (rendered.content === original.content) continue
      await writeFile(join(targetDir, rendered.path), rendered.content)
    }
  }
}

async function readSkillFiles(root: string, parent = ''): Promise<SkillFile[]> {
  const entries = await readdir(join(root, parent), { withFileTypes: true })
  const files: SkillFile[] = []
  for (const entry of entries) {
    const path = join(parent, entry.name)
    if (entry.isDirectory()) files.push(...await readSkillFiles(root, path))
    else if (entry.isFile()) files.push({ path, content: await readFile(join(root, path)) })
  }
  return files
}
