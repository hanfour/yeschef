import type { ChefTask } from '../../../shared/chef.js'
import { scanUiFiles } from './scan.js'
import type { UiCheckFile } from './types.js'

type ReadUiCheckFiles = (key: string, cwd: string) => Promise<readonly UiCheckFile[]>
type UiFindingReport = NonNullable<ChefTask['report']>['uiFindings']
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function mergeScan(task: ChefTask, scanned: ReturnType<typeof scanUiFiles>): void {
  if (!scanned.files.length) return
  const previous = task.uiCheck
  const findings = new Map((previous?.findings ?? []).map((finding) => [finding.stableKey, finding]))
  for (const [key, finding] of findings) {
    if (scanned.skipped.some((item) => sameLocation(finding, item))) findings.delete(key)
  }
  for (const finding of scanned.findings) findings.set(finding.stableKey, finding)
  task.uiCheck = {
    files: [...new Set([...(previous?.files ?? []), ...scanned.files])].sort(),
    findings: [...findings.values()].sort((a, b) => compareText(a.path, b.path) || a.line - b.line || compareText(a.id, b.id)),
    skipped: scanned.skipped,
    invalidIgnores: scanned.invalidIgnores,
    identities: scanned.identities,
  }
}

function sameLocation(a: { ruleId: string; path: string; line: number }, b: { ruleId: string; path: string; line: number }): boolean {
  return a.ruleId === b.ruleId && a.path === b.path && Math.abs(a.line - b.line) <= 5
}

export async function prepareUiCheck(task: ChefTask, unit: ChefTask['units'][number], readFiles: ReadUiCheckFiles | undefined, save: () => Promise<void>): Promise<void> {
  if (unit.kind !== 'review' || !readFiles) return
  const files = await readFiles(`chef:${task.id}`, task.cwd)
  const scanned = scanUiFiles(files, task.uiCheck?.identities ?? [])
  if (!scanned.files.length) return
  mergeScan(task, scanned)
  await save()
}

export function uiCheckPrompt(task: ChefTask): string {
  const findings = task.uiCheck?.findings ?? []
  if (!findings.length) return ''
  const rows = findings.map((finding) => `${finding.id} ${finding.ruleId} ${finding.path}:${finding.line}  ${finding.snippet}`).join('\n')
  return `\n<ui-check>\n本次任務改過的介面檔案有 ${findings.length} 項發現。每一項都要在回報的 uiFindings 說明處理方式。\n${rows}\n</ui-check>`
}

export function validateUiFindingResolution(task: ChefTask, submitted: UiFindingReport): void {
  const expected = task.uiCheck?.findings ?? [], values = submitted ?? []
  const ids = new Set(values.map((value) => value.id))
  if (ids.size !== values.length) throw Error('介面檢查回報有重複編號')
  const known = new Set(expected.map((finding) => finding.id))
  const unknown = values.filter((value) => !known.has(value.id)).map((value) => value.id)
  if (unknown.length) throw Error(`介面檢查回報包含未知編號：${unknown.join('、')}`)
  const missing = expected.filter((finding) => !ids.has(finding.id)).map((finding) => finding.id)
  if (missing.length) throw Error(`介面檢查回報缺少編號：${missing.join('、')}`)
  const blankReason = values.filter((value) => !value.reason.trim()).map((value) => value.id)
  if (blankReason.length) throw Error(`介面檢查回報必須說明處理原因：${blankReason.join('、')}`)
  const errorKept = expected.filter((finding) => finding.severity === 'error' && values.find((value) => value.id === finding.id)?.resolution === 'kept').map((finding) => finding.id)
  if (errorKept.length) throw Error(`錯誤級介面發現不能選擇 kept，請修正：${errorKept.join('、')}`)
}

export async function verifyFixedUiFindings(task: ChefTask, submitted: UiFindingReport, readFiles: ReadUiCheckFiles | undefined): Promise<ReturnType<typeof scanUiFiles> | undefined> {
  const fixed = (task.uiCheck?.findings ?? []).filter((finding) => submitted?.some((value) => value.id === finding.id && value.resolution === 'fixed'))
  if (!fixed.length) return undefined
  if (!readFiles) throw Error('介面檢查目前無法重新讀取變更檔案')
  let files: readonly UiCheckFile[]
  try { files = await readFiles(`chef:${task.id}`, task.cwd) }
  catch { throw Error('介面檢查無法重新讀取變更檔案，請確認任務的開發基準') }
  const current = scanUiFiles(files, task.uiCheck?.identities ?? [])
  const stillPresent = fixed.filter((finding) => current.findings.some((item) => sameLocation(finding, item)))
  if (stillPresent.length) throw Error(`介面檢查仍未修好：${stillPresent.map((finding) => finding.id).join('、')}`)
  return current
}

export function applyVerifiedUiCheck(task: ChefTask, scanned: ReturnType<typeof scanUiFiles> | undefined): void {
  if (!scanned || !task.uiCheck) return
  task.uiCheck = {
    ...task.uiCheck,
    findings: task.uiCheck.findings.filter((finding) => !scanned.skipped.some((item) => sameLocation(finding, item))),
    skipped: scanned.skipped,
    invalidIgnores: scanned.invalidIgnores,
    identities: scanned.identities,
  }
}
