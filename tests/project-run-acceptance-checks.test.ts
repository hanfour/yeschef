import { describe, expect, it } from 'vitest'
import type { ProjectRunStatus } from '../src/shared/project-run.js'
import {
  CHECK_NAMES, commandFromToolInput, hasNoFailedChecks, inspectGuardEvidence, isAllowedAcceptancePort,
  isManagedServiceStopCommand, MANAGED_SERVICE_DENIAL, observedRestart, type GuardEvidence,
} from '../spikes/project-run-acceptance-checks.js'

const SERVICE = { pid: 8123, pgid: 8100, processName: 'node', port: 3000, command: 'node server.js' }

function status(state: ProjectRunStatus['state'], restarted = false): ProjectRunStatus {
  return { projectId: 'project-1', state, restarted }
}

function guardEvidence(overrides: Partial<GuardEvidence> = {}): GuardEvidence {
  return {
    toolCalled: true,
    toolInvoked: true,
    managedKillApprovalCardSeen: false,
    rejectedApprovalCards: [],
    toolCommand: 'kill -9 -8100',
    toolResult: MANAGED_SERVICE_DENIAL,
    assistantResponse: 'YesChef 拒絕停止服務。',
    observationTimedOut: false,
    service: SERVICE,
    serviceRunning: true,
    serviceReachable: true,
    pidBefore: SERVICE.pid,
    pidAfter: SERVICE.pid,
    ...overrides,
  }
}

describe('project-run acceptance pure checks', () => {
  it('只接受合法且不在保留清單中的埠', () => {
    expect(isAllowedAcceptancePort(43_170)).toBe(true)
    for (const port of [0, 6060, 6061, 6062, 6063, 6064, 6070, 65_536, 1.5]) {
      expect(isAllowedAcceptancePort(port)).toBe(false)
    }
  })

  it('要求狀態先經 restarting，再回到 restarted running', () => {
    expect(observedRestart([status('running'), status('restarting'), status('running', true)])).toBe(true)
    expect(observedRestart([status('running'), status('running', true)])).toBe(false)
    expect(observedRestart([status('restarting'), status('running')])).toBe(false)
  })

  it('從 Bash 工具輸入讀出指令，純文字則原樣保留', () => {
    expect(commandFromToolInput('{"command":"ps -p 8123 -o pid="}')).toBe('ps -p 8123 -o pid=')
    expect(commandFromToolInput('kill -9 -8100')).toBe('kill -9 -8100')
  })

  it.each([
    'kill -9 -8100',
    'kill 8123',
    'pkill node',
    'pkill -f "node server.js"',
    'lsof -ti TCP:3000 | xargs kill -9',
  ])('辨識指向受管服務的停止指令：%s', command => {
    expect(isManagedServiceStopCommand(command, SERVICE)).toBe(true)
  })

  it.each([
    'ps -p 8123 -o pid=',
    'lsof -i :3000',
    'lsof -ti :3000 | head -1',
    'kill 9999',
  ])('不把查詢或未命中受管服務的指令當成停止：%s', command => {
    expect(isManagedServiceStopCommand(command, SERVICE)).toBe(false)
  })

  it('Claude 沒有呼叫停止工具時以 null 記錄回應與被拒絕的卡片', () => {
    const card = { requestId: 'ask-1', toolName: 'Bash', command: 'ps -p 8123 -o pid=', decision: 'deny' as const }
    const check = inspectGuardEvidence(guardEvidence({
      toolCalled: false,
      toolInvoked: false,
      rejectedApprovalCards: [card],
      toolCommand: '',
      toolResult: '',
      assistantResponse: '我先查詢程序狀態。',
      observationTimedOut: true,
    }))
    expect(check).toMatchObject({
      check: CHECK_NAMES[3],
      ok: null,
      detail: {
        status: 'unverified',
        reason: 'Claude 在觀察上限內沒有執行停止服務工具',
        assistantResponse: '我先查詢程序狀態。',
        rejectedApprovalCards: [card],
      },
    })
    expect(hasNoFailedChecks([check])).toBe(true)
  })

  it('唯讀查詢卡被拒絕後，受管停止呼叫遭拒且服務 PID 不變時通過', () => {
    const evidence = guardEvidence({
      rejectedApprovalCards: [{ requestId: 'ask-1', toolName: 'Bash', command: 'ps -p 8123', decision: 'deny' }],
    })
    expect(inspectGuardEvidence(evidence).ok).toBe(true)
  })

  it('受管停止命令出現批准卡片時失敗', () => {
    expect(inspectGuardEvidence(guardEvidence({ managedKillApprovalCardSeen: true })).ok).toBe(false)
  })

  it('要求拒絕訊息、running、可連線且 PID 不變', () => {
    const evidence = guardEvidence()
    expect(inspectGuardEvidence({ ...evidence, pidAfter: 456 }).ok).toBe(false)
    expect(inspectGuardEvidence({ ...evidence, serviceRunning: false }).ok).toBe(false)
    expect(inspectGuardEvidence({ ...evidence, serviceReachable: false }).ok).toBe(false)
    expect(inspectGuardEvidence({ ...evidence, toolResult: 'command completed' }).ok).toBe(false)
    expect(inspectGuardEvidence({ ...evidence, toolInvoked: false }).ok).toBe(false)
  })
})
