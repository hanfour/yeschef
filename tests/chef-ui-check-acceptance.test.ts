import { describe, expect, it } from 'vitest'
import type { ChefTask } from '../src/shared/chef.js'
import { DEMO_FILES } from '../spikes/chef-ui-check-acceptance-runtime.js'
import {
  classifyApproval, classifyExternalCommand, countUiCheckReportRejections, inspectTask, timeoutMinutes,
} from '../spikes/chef-ui-check-acceptance-checks.js'
import { scanUiFiles } from '../src/main/chef/ui-check/scan.js'

const fixtureFinding = {
  id: 'F1', stableKey: 'a'.repeat(64), ruleId: 'side-stripe' as const, severity: 'warning' as const,
  description: '單側粗框', path: 'styles.css', line: 2, snippet: 'border-left: 4px solid #e8590c;',
}

function task(overrides: Partial<ChefTask> = {}): ChefTask {
  return {
    id: 'task-1', projectId: 'project-1', cwd: '/tmp/demo', goal: '加提示卡片', purpose: undefined, followups: [],
    policy: { mode: 'auto', allowed: ['claude:test'], maxExecutions: 6, deadlineMinutes: 120 },
    status: 'completed', createdAt: 1, deadlineAt: 2,
    units: [{ id: 'review-1', parentId: null, title: '驗收', goal: '核對介面', kind: 'review', status: 'done' }],
    attempts: [{
      id: 'attempt-1', unitId: 'review-1', workerId: 'worker-1', provider: 'claude', model: 'test', status: 'done',
      startedAt: 1, endedAt: 2, reason: '', events: [{ kind: 'user-text', text: '<ui-check> F1 side-stripe </ui-check>' }],
      pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false,
    }],
    reason: '', cancelRequested: false, needsReconciliation: false,
    uiCheck: { files: ['styles.css'], findings: [fixtureFinding], skipped: [], invalidIgnores: [], identities: [{ key: 'a'.repeat(64), id: 'F1' }] },
    report: { unitId: 'review-1', outcome: 'completed', summary: '完成', checks: [], uiFindings: [{ id: 'F1', resolution: 'fixed', reason: '移除單側粗框' }] },
    ...overrides,
  } as ChefTask
}

function check(result: ReturnType<typeof inspectTask>, name: string) {
  const found = result.find((item) => item.check === name)
  if (found === undefined) throw new Error(`missing check ${name}`)
  return found
}

describe('chef-ui-check acceptance pure checks', () => {
  it('給沒有觸發規則的示範專案初始檔案', () => {
    const files = Object.entries(DEMO_FILES).map(([path, text]) => ({ path, text }))
    expect(scanUiFiles(files).findings).toEqual([])
    expect(scanUiFiles(files).invalidIgnores).toEqual([])
  })

  it('驗收提示包含介面檢查標記與 side-stripe，fixed 後 CSS 不再觸發', () => {
    const result = inspectTask(task(), '.notice { background: #fff3bf; padding: 16px; }')
    expect(check(result, 'review-ui-check-prompt')).toMatchObject({ ok: true, detail: { evidence: 'attempt-events', hasUiCheckTag: true, hasSideStripe: true } })
    expect(check(result, 'side-stripe-final-resolution')).toMatchObject({ ok: true, detail: { remainingSideStripeCount: 0 } })
    expect(check(result, 'task-completed').ok).toBe(true)
  })

  it('提示原文不可取得時使用 task.uiCheck.findings fallback 並明確註記', () => {
    const value = task({ attempts: [] })
    expect(check(inspectTask(value, ''), 'review-ui-check-prompt')).toMatchObject({
      ok: true,
      detail: { evidence: 'task.uiCheck.findings fallback', promptTextAvailable: false, hasSideStripeFinding: true },
    })
  })

  it('提示原文可讀但缺少 side-stripe 時不改用 fallback 掩蓋', () => {
    const value = task({
      attempts: [{ ...task().attempts[0]!, events: [{ kind: 'user-text', text: '<ui-check> F1 </ui-check>' }] }],
    })
    expect(check(inspectTask(value, ''), 'review-ui-check-prompt').ok).toBe(false)
  })

  it('要求每個 F 編號都有回報及非空原因', () => {
    const value = task({ report: { ...task().report!, uiFindings: [{ id: 'F1', resolution: 'fixed', reason: '  ' }] } })
    expect(check(inspectTask(value, ''), 'ui-findings-covered-with-reasons')).toMatchObject({
      ok: false,
      detail: { missing: [], missingReasons: ['F1'] },
    })
    const missing = task({ report: { ...task().report!, uiFindings: [] } })
    expect(check(inspectTask(missing, ''), 'ui-findings-covered-with-reasons').detail).toMatchObject({ missing: ['F1'] })
  })

  it('統計 report_result 發生且含「介面檢查」的錯誤；成功結果與其他工具不計', () => {
    const value = task({ attempts: [{
      ...task().attempts[0]!,
      events: [
        { kind: 'tool-use', id: 'bad-1', name: 'mcp__chef__report_result' },
        { kind: 'tool-result', id: 'bad-1', isError: true, content: [{ type: 'text', text: '介面檢查回報格式不正確' }] },
        { kind: 'tool-use', id: 'ok-1', name: 'report_result' },
        { kind: 'tool-result', id: 'ok-1', isError: false, content: '介面檢查已完成' },
        { kind: 'tool-use', id: 'read-1', name: 'Read' },
        { kind: 'tool-result', id: 'read-1', isError: true, content: '介面檢查' },
      ],
    }] })
    expect(countUiCheckReportRejections(value)).toBe(1)
    expect(check(inspectTask(value, ''), 'ui-check-report-result-rejections')).toMatchObject({ ok: true, detail: { count: 1 } })
    expect(countUiCheckReportRejections(task())).toBe(0)
  })

  it('fixed 但 CSS 仍有 side-stripe 時失敗；kept 必須保留原因', () => {
    const remaining = '.notice { border-left: 4px solid #e8590c; }'
    expect(check(inspectTask(task(), remaining), 'side-stripe-final-resolution').ok).toBe(false)
    const kept = task({ report: { ...task().report!, uiFindings: [{ id: 'F1', resolution: 'kept', reason: '依照使用者指定保留提示樣式' }] } })
    expect(check(inspectTask(kept, remaining), 'side-stripe-final-resolution').ok).toBe(true)
    const noReason = task({ report: { ...task().report!, uiFindings: [{ id: 'F1', resolution: 'kept', reason: '' }] } })
    expect(check(inspectTask(noReason, remaining), 'side-stripe-final-resolution').ok).toBe(false)
  })

  it('只把 completed 視為最終通過', () => {
    expect(check(inspectTask(task({ status: 'blocked' }), ''), 'task-completed')).toMatchObject({ ok: false, detail: { status: 'blocked' } })
  })

  it('逾時預設四十分鐘且可用正整數覆寫', () => {
    expect(timeoutMinutes(undefined)).toBe(40)
    expect(timeoutMinutes('12')).toBe(12)
    expect(() => timeoutMinutes('0')).toThrow('CHEF_UI_CHECK_TIMEOUT_MINUTES')
  })

  it('放行示範專案檔案操作與本機 shell，拒絕外部路徑及外部指令', () => {
    expect(classifyApproval('Read', { file_path: 'index.html' }, '/tmp/demo').decision).toBe('allowed')
    expect(classifyApproval('Edit', { file_path: '/tmp/demo/styles.css' }, '/tmp/demo').decision).toBe('allowed')
    expect(classifyApproval('Read', { file_path: '../private.txt' }, '/tmp/demo').decision).toBe('denied')
    // 驗收時讀卡片的實際樣式會用 view_eval；第一輪實機因為被拒而讓任務卡住。
    expect(classifyApproval('mcp__yeschef__view_eval', { expression: 'document.title' }, '/tmp/demo').decision).toBe('allowed')
    expect(classifyApproval('view_screenshot', {}, '/tmp/demo').decision).toBe('allowed')
    expect(classifyApproval('Bash', { command: 'git diff -- styles.css' }, '/tmp/demo').decision).toBe('allowed')
    expect(classifyApproval('Bash', { command: 'git push origin main' }, '/tmp/demo')).toMatchObject({ decision: 'denied', external: true })
    expect(classifyApproval('Bash', { command: 'gh pr create' }, '/tmp/demo')).toMatchObject({ decision: 'denied', external: true })
    expect(classifyApproval('Bash', { command: 'git commit -am done' }, '/tmp/demo')).toMatchObject({ decision: 'denied', external: false })
    expect(classifyApproval('Bash', { command: 'cat ../private.txt' }, '/tmp/demo')).toMatchObject({ decision: 'denied', external: false })
    expect(classifyExternalCommand('gh', '')).toBe(true)
  })
})
