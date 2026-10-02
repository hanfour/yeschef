export type SkillProvider = 'claude' | 'codex' | 'grok'

export interface SkillFile {
  readonly path: string
  readonly content: Buffer
}

const PROVIDER_VALUES = {
  claude: { provider: 'claude', skill_prefix: '/', shell_tool: 'Bash' },
  codex: { provider: 'codex', skill_prefix: '$', shell_tool: 'shell' },
  grok: { provider: 'grok', skill_prefix: '/', shell_tool: 'run_terminal_command' },
} as const

const VARIABLE_NAMES = new Set(['provider', 'skill_prefix', 'shell_tool', 'skill_dir'])
const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g

export function findUnknownSkillVariables(files: readonly SkillFile[]): string[] {
  const warnings = new Set<string>()
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue
    for (const match of file.content.toString('utf8').matchAll(VARIABLE_PATTERN)) {
      const name = match[1]!
      if (!VARIABLE_NAMES.has(name)) warnings.add(`${file.path}：未知變數 {{${name}}}，安裝後會原樣保留`)
    }
  }
  return [...warnings]
}

export function replaceSkillVariables(
  files: readonly SkillFile[],
  provider: SkillProvider,
  skillDir: string,
): { files: SkillFile[]; warnings: string[] } {
  const warnings = findUnknownSkillVariables(files)
  const values = PROVIDER_VALUES[provider]
  const rendered = files.map(file => {
    if (!file.path.endsWith('.md')) return file
    const source = file.content.toString('utf8')
    let changed = false
    const content = source.replace(VARIABLE_PATTERN, (token, name: string) => {
      if (!VARIABLE_NAMES.has(name)) return token
      changed = true
      return name === 'skill_dir' ? skillDir : values[name as keyof typeof values]
    })
    return changed ? { ...file, content: Buffer.from(content, 'utf8') } : file
  })
  return { files: rendered, warnings }
}
