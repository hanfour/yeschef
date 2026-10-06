import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectRunCandidate } from '../../shared/project-run.js'
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

export interface ProjectRunDiscoveryPorts {
  readonly isFree: (port: number) => Promise<boolean>
  readonly findFreePort: () => Promise<number>
}

/** 可替換連接埠的預設埠被佔用時（例如另一個服務已在跑），先換成空著的埠。 */
async function withFreePort(candidate: ProjectRunCandidate, ports: ProjectRunDiscoveryPorts): Promise<ProjectRunCandidate> {
  if (candidate.portStrategy !== 'placeholder' || candidate.port === null) return candidate
  if (await ports.isFree(candidate.port)) return candidate
  return { ...candidate, port: await ports.findFreePort() }
}

export async function discoverProjectRunCandidates(rootPath: string, ports?: ProjectRunDiscoveryPorts): Promise<readonly ProjectRunCandidate[]> {
  const entries = await readdir(rootPath)
  const pythonFiles = PYTHON_FILES.filter(filename => entries.includes(filename))
  const pythonSources: Record<string, string> = {}
  for (const filename of pythonFiles) {
    const text = await optionalText(join(rootPath, filename))
    if (text !== undefined) pythonSources[filename] = text
  }
  const input: ProjectRunDetectInput = {
    packageJson: await optionalText(join(rootPath, 'package.json')),
    lockfiles: LOCKFILES.filter(filename => entries.includes(filename)),
    procfile: await optionalText(join(rootPath, 'Procfile')),
    readme: await optionalText(join(rootPath, 'README.md')) ?? await optionalText(join(rootPath, 'readme.md')),
    pythonFiles,
    pythonSources,
    hasDotVenv: await isDirectory(join(rootPath, '.venv')),
    hasVenv: await isDirectory(join(rootPath, 'venv')),
  }
  const candidates = detectProjectRunCandidates(input)
  return ports === undefined ? candidates : Promise.all(candidates.map(candidate => withFreePort(candidate, ports)))
}
