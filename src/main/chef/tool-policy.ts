import { ERROR_INTAKE_SETUP_TOOL_NAMES } from '../../shared/error-intake.js'

export type ChefToolDecision = 'allow' | 'ask' | 'unknown'

export function chefToolPolicy(toolName: string): ChefToolDecision {
  const bareName = toolName.startsWith('mcp__chef__') ? toolName.slice('mcp__chef__'.length) : toolName
  if (bareName === ERROR_INTAKE_SETUP_TOOL_NAMES[1]) return 'allow'
  if (bareName === ERROR_INTAKE_SETUP_TOOL_NAMES[0]) return 'ask'
  return 'unknown'
}
