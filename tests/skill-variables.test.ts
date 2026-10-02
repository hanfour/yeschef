import { describe, expect, it } from 'vitest'
import { replaceSkillVariables } from '../src/main/skills/variables.js'

describe('replaceSkillVariables', () => {
  it.each([
    ['claude', 'claude', '/', 'Bash', '/shared/revisions/r1/claude/skills/design'],
    ['codex', 'codex', '$', 'shell', '/shared/revisions/r1/codex/skills/design'],
    ['grok', 'grok', '/', 'run_terminal_command', '/shared/revisions/r1/grok/skills/design'],
  ] as const)('%s 產生自己的四個變數值', (provider, providerValue, prefix, shellTool, skillDir) => {
    const source = Buffer.from('{{provider}} {{skill_prefix}} {{shell_tool}} {{skill_dir}}')
    const result = replaceSkillVariables([{ path: 'SKILL.md', content: source }], provider, skillDir)

    expect(result.files[0]?.content.toString()).toBe(`${providerValue} ${prefix} ${shellTool} ${skillDir}`)
    expect(result.warnings).toEqual([])
  })

  it('未知變數原樣保留並回報檔名警告', () => {
    const source = Buffer.from('Use {{shell_tool_name}} and {{provider}}')
    const result = replaceSkillVariables([{ path: 'references/tooling.md', content: source }], 'claude', '/skills/design')

    expect(result.files[0]?.content.toString()).toBe('Use {{shell_tool_name}} and claude')
    expect(result.warnings).toEqual(['references/tooling.md：未知變數 {{shell_tool_name}}，安裝後會原樣保留'])
  })

  it('非 .md 檔案不替換也不掃描變數', () => {
    const source = Buffer.from('{{provider}} {{unknown}}')
    const result = replaceSkillVariables([{ path: 'scripts/run.sh', content: source }], 'codex', '/skills/design')

    expect(result.files[0]?.content).toBe(source)
    expect(result.warnings).toEqual([])
  })

  it('沒有變數時保留原始內容', () => {
    const source = Buffer.from('# Read carefully\r\n')
    const result = replaceSkillVariables([{ path: 'SKILL.md', content: source }], 'grok', '/skills/design')

    expect(result.files[0]?.content).toBe(source)
    expect(result.files[0]?.content.toString()).toBe('# Read carefully\r\n')
    expect(result.warnings).toEqual([])
  })
})
