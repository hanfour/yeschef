export interface CodexReasoningEffortOption {
  readonly reasoningEffort: string
  readonly description: string
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const EFFORT_LEVEL = new Map<string, number>(EFFORT_ORDER.map((effort, index) => [effort, index]))

export function selectCodexReasoningEffort(
  globalEffort: string | undefined,
  supported: readonly CodexReasoningEffortOption[] | undefined,
  defaultEffort: string | undefined,
): string | undefined {
  if (globalEffort === undefined || !supported || supported.length === 0) return undefined
  const supportedEfforts = supported.map((option) => option.reasoningEffort)
  if (supportedEfforts.includes(globalEffort)) return globalEffort
  const targetLevel = EFFORT_LEVEL.get(globalEffort)
  if (targetLevel === undefined) return defaultEffort && supportedEfforts.includes(defaultEffort) ? defaultEffort : undefined
  const lower = supportedEfforts
    .filter((effort) => (EFFORT_LEVEL.get(effort) ?? Infinity) <= targetLevel)
    .sort((a, b) => EFFORT_LEVEL.get(a)! - EFFORT_LEVEL.get(b)!)
  const clamped = lower.at(-1)
  return clamped ?? (defaultEffort && supportedEfforts.includes(defaultEffort) ? defaultEffort : undefined)
}
