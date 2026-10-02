export type UiRuleId = 'side-stripe' | 'gradient-text' | 'eyebrow-label' | 'tiny-text' | 'focus-removed' | 'pure-black-white'
export type UiRuleSeverity = 'warning' | 'error'

export interface UiCheckFile {
  readonly path: string
  readonly text: string
}

export interface Finding {
  readonly ruleId: UiRuleId
  readonly path: string
  readonly line: number
  readonly snippet: string
}

export interface UiCheckFinding extends Finding {
  readonly id: string
  readonly stableKey: string
  readonly severity: UiRuleSeverity
  readonly description: string
}

export interface UiCheckSkipped extends Finding {
  readonly severity: UiRuleSeverity
  readonly description: string
  readonly reason: string
}

export interface UiCheckInvalidIgnore {
  readonly ruleId: UiRuleId
  readonly path: string
  readonly line: number
  readonly snippet: string
}

export interface UiFindingIdentity {
  readonly key: string
  readonly id: string
}

export interface UiCheckRule {
  readonly id: UiRuleId
  readonly severity: UiRuleSeverity
  readonly describe: string
  check(file: UiCheckFile): Finding[]
}

export interface UiCheckState {
  readonly files: string[]
  readonly findings: UiCheckFinding[]
  readonly skipped: UiCheckSkipped[]
  readonly invalidIgnores: UiCheckInvalidIgnore[]
  readonly identities: UiFindingIdentity[]
}
