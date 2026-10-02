const LEGACY_TOOL_PREFIX = 'mcp__sidepane__'
const CURRENT_TOOL_PREFIX = 'mcp__yeschef__'

export function canonicalToolName(name: string): string {
  return name.startsWith(LEGACY_TOOL_PREFIX)
    ? `${CURRENT_TOOL_PREFIX}${name.slice(LEGACY_TOOL_PREFIX.length)}`
    : name
}
