import type { ProjectRunCandidate } from '../../shared/project-run.js'

export interface ProjectRunDetectInput {
  readonly packageJson?: string
  readonly lockfiles?: readonly string[]
  readonly procfile?: string
  readonly readme?: string
  readonly pythonFiles?: readonly string[]
  readonly hasDotVenv?: boolean
  readonly hasVenv?: boolean
}

const LOCKFILE_MANAGERS: Readonly<Record<string, string>> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
}

function managerFor(lockfiles: readonly string[] = []): string {
  for (const filename of Object.keys(LOCKFILE_MANAGERS)) {
    if (lockfiles.includes(filename)) return LOCKFILE_MANAGERS[filename]!
  }
  return 'npm'
}

function explicitPort(command: string): number | null {
  const match = /(?:--port(?:\s+|=)|(?:^|\s)-p(?:\s+|=)|\bPORT=)(\d{1,5})/.exec(command)
  if (match === null) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? port : null
}

function commonPort(command: string): number | null {
  if (/\bvite\b/i.test(command)) return 5173
  if (/\bnext\b/i.test(command)) return 3000
  if (/\bastro\b/i.test(command)) return 4321
  if (/webpack(?:-dev-server|\s+serve)/i.test(command)) return 8080
  if (/manage\.py\s+runserver/i.test(command)) return 8000
  if (/\bflask\s+run\b/i.test(command)) return 5000
  return null
}

function portFor(command: string): number | null {
  return explicitPort(command) ?? commonPort(command)
}

function frontendDevServer(command: string): boolean {
  const vite = /\bvite\b/i.test(command) && !/\bvite\s+preview\b/i.test(command)
  return vite || /\bnext\s+dev\b|\bastro\s+dev\b|webpack(?:-dev-server|\s+serve)/i.test(command)
}

function packageCandidates(input: ProjectRunDetectInput): ProjectRunCandidate[] {
  if (input.packageJson === undefined) return []
  let scripts: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(input.packageJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    const rawScripts = (parsed as Record<string, unknown>)['scripts']
    if (typeof rawScripts !== 'object' || rawScripts === null || Array.isArray(rawScripts)) return []
    scripts = rawScripts as Record<string, unknown>
  } catch {
    return []
  }
  const manager = managerFor(input.lockfiles)
  return (['dev', 'start', 'preview', 'serve'] as const).flatMap(script => {
    const value = scripts[script]
    if (typeof value !== 'string' || value.trim() === '') return []
    return [{
      command: `${manager} run ${script}`,
      cwd: '.',
      port: portFor(value),
      source: `package.json scripts.${script}`,
      watchEnabled: !frontendDevServer(value),
    }]
  })
}

function pythonCandidates(input: ProjectRunDetectInput): ProjectRunCandidate[] {
  const interpreter = input.hasDotVenv ? '.venv/bin/python' : input.hasVenv ? 'venv/bin/python' : 'python3'
  const names = ['manage.py', 'app.py', 'server.py', 'main.py']
  return names.filter(name => input.pythonFiles?.includes(name)).map(name => ({
    command: `${interpreter} ${name}`,
    cwd: '.',
    port: null,
    source: `Python ${name}`,
    watchEnabled: true,
  }))
}

function procfileCandidate(text: string | undefined): ProjectRunCandidate[] {
  if (text === undefined) return []
  const web = text.split(/\r?\n/).map(line => /^\s*web\s*:\s*(.*?)\s*$/.exec(line)?.[1]).find(Boolean)
  return web === undefined || web.trim() === ''
    ? []
    : [{ command: web.trim(), cwd: '.', port: portFor(web), source: 'Procfile web', watchEnabled: true }]
}

function localPort(block: string): number | null {
  const match = /(?:localhost|127\.0\.0\.1):(\d{1,5})/i.exec(block)
  if (match === null) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? port : null
}

function readmeCandidates(text: string | undefined): ProjectRunCandidate[] {
  if (text === undefined) return []
  const result: ProjectRunCandidate[] = []
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const block = match[1] ?? ''
    const command = block.split(/\r?\n/).map(line => line.trim())
      .find(line => line !== '' && !line.startsWith('#') && !/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+/i.test(line))
    if (command === undefined) continue
    result.push({
      command, cwd: '.', port: localPort(block) ?? portFor(command),
      source: 'README 程式碼區塊', watchEnabled: !frontendDevServer(command),
    })
  }
  return result
}

/** 只讀輸入內容，不執行候選指令。 */
export function detectProjectRunCandidates(input: ProjectRunDetectInput): readonly ProjectRunCandidate[] {
  return [
    ...packageCandidates(input),
    ...pythonCandidates(input),
    ...procfileCandidate(input.procfile),
    ...readmeCandidates(input.readme),
  ]
}
