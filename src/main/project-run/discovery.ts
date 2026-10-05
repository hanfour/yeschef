import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { detectProjectRunCandidates, type ProjectRunDetectInput } from './detect.js'

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json']
const PYTHON_FILES = ['manage.py', 'app.py', 'server.py', 'main.py']

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function discoverProjectRunCandidates(rootPath: string) {
  const entries = await readdir(rootPath)
  const input: ProjectRunDetectInput = {
    packageJson: await optionalText(join(rootPath, 'package.json')),
    lockfiles: LOCKFILES.filter(filename => entries.includes(filename)),
    procfile: await optionalText(join(rootPath, 'Procfile')),
    readme: await optionalText(join(rootPath, 'README.md')) ?? await optionalText(join(rootPath, 'readme.md')),
    pythonFiles: PYTHON_FILES.filter(filename => entries.includes(filename)),
    hasDotVenv: await isDirectory(join(rootPath, '.venv')),
    hasVenv: await isDirectory(join(rootPath, 'venv')),
  }
  return detectProjectRunCandidates(input)
}
