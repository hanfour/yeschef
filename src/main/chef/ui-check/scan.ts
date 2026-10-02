import { createHash } from 'node:crypto'
import { uiCheckRules } from './rules/index.js'
import { snippetAt, uiIgnoreDirectives } from './source.js'
import type { UiCheckFile, UiCheckFinding, UiCheckInvalidIgnore, UiCheckSkipped, UiFindingIdentity, UiRuleId } from './types.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
type FindingCandidate = Omit<UiCheckFinding, 'id' | 'stableKey'>

function compareFinding(a: { path: string; line: number; ruleId: string; snippet: string }, b: { path: string; line: number; ruleId: string; snippet: string }): number {
  return compareText(a.path, b.path) || a.line - b.line || compareText(a.ruleId, b.ruleId) || compareText(a.snippet, b.snippet)
}

function scanFile(file: UiCheckFile) {
  const directives = uiIgnoreDirectives(file.text)
  const findings: FindingCandidate[] = []
  const skipped: UiCheckSkipped[] = []
  for (const rule of uiCheckRules) {
    const reason = directives.find((directive) => directive.ruleId === rule.id && directive.reason)?.reason
    for (const finding of rule.check(file)) {
      const described = { ...finding, severity: rule.severity, description: rule.describe }
      if (reason) skipped.push({ ...described, reason })
      else findings.push(described)
    }
  }
  const invalidIgnores: UiCheckInvalidIgnore[] = directives
    .filter((directive) => !directive.reason && uiCheckRules.some((rule) => rule.id === directive.ruleId))
    .map((directive) => ({
      ruleId: directive.ruleId as UiRuleId,
      path: file.path,
      line: directive.line,
      snippet: directive.snippet,
    }))
  return { findings: findings.sort(compareFinding), skipped: skipped.sort(compareFinding), invalidIgnores }
}

function stableKey(finding: FindingCandidate, occurrence: number): string {
  return digest(JSON.stringify([finding.ruleId, finding.path, finding.snippet, occurrence]))
}

function identitiesFor(findings: readonly FindingCandidate[], previous: readonly UiFindingIdentity[]) {
  const existing = new Map(previous.map(({ key, id }) => [key, id]))
  const occurrence = new Map<string, number>()
  const next = previous.reduce((max, value) => Math.max(max, Number(/^F(\d+)$/.exec(value.id)?.[1] ?? 0)), 0) + 1
  let index = next
  const identities: UiFindingIdentity[] = []
  const assigned = findings.map((finding) => {
    const base = JSON.stringify([finding.ruleId, finding.path, finding.snippet])
    const ordinal = occurrence.get(base) ?? 0
    occurrence.set(base, ordinal + 1)
    const key = stableKey(finding, ordinal)
    const id = existing.get(key) ?? 'F' + index++
    identities.push({ key, id })
    return { ...finding, id, stableKey: key }
  })
  const merged = new Map(previous.map((item) => [item.key, item]))
  for (const item of identities) merged.set(item.key, item)
  return { findings: assigned, identities: [...merged.values()] }
}

export function scanUiFiles(files: readonly UiCheckFile[], previous: readonly UiFindingIdentity[] = []) {
  const scanned = files.map(scanFile)
  const findings = scanned.flatMap((result) => result.findings).sort(compareFinding)
  const result = identitiesFor(findings, previous)
  return {
    files: [...new Set(files.map((file) => file.path))].sort(),
    ...result,
    skipped: scanned.flatMap((scan) => scan.skipped).sort(compareFinding),
    invalidIgnores: scanned.flatMap((scan) => scan.invalidIgnores).sort(compareFinding),
  }
}
