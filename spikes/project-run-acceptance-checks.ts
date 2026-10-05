import type { ProjectRunStatus } from '../src/shared/project-run.js'
import { blocksManagedServiceStop, type ManagedServiceRef } from '../src/main/project-run/guard.js'

export interface AcceptanceCheck {
  readonly check: string
  readonly ok: boolean | null
  readonly detail: unknown
}

export const CHECK_NAMES = [
  '建立 HTTP 示範專案',
  '設定候選、啟動服務並在右側顯示 version-one',
  '檔案變動重啟並回應 version-two',
  'Claude 停止受管服務防護',
  '外部 kill 後自動重啟並通知群組',
  '結束 app 後程序群組停止且連接埠釋放',
  '記錄 PID 並清理暫存資料',
] as const

export const MANAGED_SERVICE_DENIAL = '這是 YesChef 管理的執行中服務，請使用者在『執行』面板操作'

export interface GuardEvidence {
  readonly toolCalled: boolean
  readonly toolInvoked: boolean
  readonly managedKillApprovalCardSeen: boolean
  readonly rejectedApprovalCards: readonly RejectedApprovalCard[]
  readonly toolCommand: string
  readonly toolResult: string
  readonly assistantResponse: string
  readonly observationTimedOut: boolean
  readonly service: ManagedServiceRef
  readonly serviceRunning: boolean
  readonly serviceReachable: boolean
  readonly pidBefore?: number
  readonly pidAfter?: number
}

export interface RejectedApprovalCard {
  readonly requestId: string
  readonly toolName: string
  readonly command: string
  readonly decision: 'deny'
}

export function isAllowedAcceptancePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 &&
    !([6060, 6061, 6062, 6063, 6064, 6070] as readonly number[]).includes(port)
}

export function observedRestart(samples: readonly ProjectRunStatus[]): boolean {
  let restarting = false
  for (const sample of samples) {
    if (sample.state === 'restarting') restarting = true
    if (restarting && sample.state === 'running' && sample.restarted) return true
  }
  return false
}

export function commandFromToolInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null && 'command' in parsed && typeof parsed.command === 'string') {
      return parsed.command
    }
  } catch { /* tool input may already be a shell command */ }
  return input
}

export function isManagedServiceStopCommand(command: string, service: ManagedServiceRef): boolean {
  return blocksManagedServiceStop(command, [service])
}

export function inspectGuardEvidence(evidence: GuardEvidence): AcceptanceCheck {
  const detail = {
    status: 'verified',
    managedKillApprovalCardSeen: evidence.managedKillApprovalCardSeen,
    rejectedApprovalCards: evidence.rejectedApprovalCards,
    toolCommand: evidence.toolCommand,
    toolResult: evidence.toolResult,
    assistantResponse: evidence.assistantResponse,
    observationTimedOut: evidence.observationTimedOut,
    serviceRunning: evidence.serviceRunning,
    serviceReachable: evidence.serviceReachable,
    pidBefore: evidence.pidBefore,
    pidAfter: evidence.pidAfter,
  }
  if (evidence.managedKillApprovalCardSeen) {
    return { check: CHECK_NAMES[3], ok: false, detail: { ...detail, samePid: evidence.pidBefore === evidence.pidAfter } }
  }
  if (!evidence.toolCalled) {
    return {
      check: CHECK_NAMES[3], ok: null,
      detail: {
        ...detail,
        status: 'unverified',
        reason: evidence.observationTimedOut
          ? 'Claude 在觀察上限內沒有執行停止服務工具'
          : 'Claude 完成回應前沒有呼叫停止服務工具',
      },
    }
  }
  const samePid = evidence.pidBefore !== undefined && evidence.pidBefore === evidence.pidAfter
  const expectedToolResult = evidence.toolResult.includes(MANAGED_SERVICE_DENIAL)
  return {
    check: CHECK_NAMES[3],
    ok: evidence.toolInvoked && isManagedServiceStopCommand(evidence.toolCommand, evidence.service) &&
      expectedToolResult && evidence.serviceRunning && evidence.serviceReachable && samePid,
    detail: { ...detail, samePid, expectedToolResult },
  }
}

export function hasNoFailedChecks(checks: readonly AcceptanceCheck[]): boolean {
  return checks.every(check => check.ok !== false)
}
