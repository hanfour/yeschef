import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { CHEF_LABEL, GENERAL_TITLE, MSG, labelFor, roleOf, titleOf } from '../src/main/group/messages.js'
import { SYSTEM_LABEL, USER_LABEL, senderLabel } from '../src/shared/group.js'
import { GROUP_UI_TEXT } from '../src/renderer/components/GroupPane.js'
import { LEFT_PANE_UI_TEXT } from '../src/renderer/components/LeftPane.js'
import type { ChefAttempt, ChefTask } from '../src/shared/chef.js'

const attempt = (over: Partial<ChefAttempt>): ChefAttempt => ({
  id: 'a1', unitId: 'u1', workerId: 'w1', provider: 'claude', model: 'sonnet', status: 'running',
  startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false,
  ...over,
})

const task = (over: Partial<ChefTask> = {}): ChefTask => ({
  id: 't1', projectId: 'p1', cwd: '/repo', goal: '把整份報表補完', followups: [],
  policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 8, deadlineMinutes: 60 },
  status: 'running', createdAt: 0, deadlineAt: 0,
  units: [
    { id: 'u1', parentId: null, title: '規劃與執行', goal: 'g', kind: 'analysis', status: 'running' },
    { id: 'u2', parentId: 'u1', title: '實作', goal: 'g', kind: 'code', status: 'queued' },
    { id: 'u3', parentId: 'u1', title: '驗收', goal: 'g', kind: 'review', status: 'queued' },
  ],
  attempts: [], reason: '', cancelRequested: false, needsReconciliation: false,
  ...over,
})

describe('角色與 label', () => {
  it('根 unit 與 review unit 都是主廚', () => {
    const t = task()
    expect(roleOf(t, attempt({ unitId: 'u1' }))).toBe('chef')
    expect(roleOf(t, attempt({ unitId: 'u3' }))).toBe('chef')
    expect(labelFor(t, attempt({ unitId: 'u1' }))).toBe(CHEF_LABEL)
    expect(labelFor(t, attempt({ unitId: 'u3' }))).toBe(CHEF_LABEL)
  })

  it('worker 依同一家的第幾個 attempt 編號,主廚不佔號', () => {
    const attempts = [
      attempt({ id: 'a1', unitId: 'u1', provider: 'claude' }),
      attempt({ id: 'a2', unitId: 'u2', provider: 'codex' }),
      attempt({ id: 'a3', unitId: 'u2', provider: 'codex' }),
      attempt({ id: 'a4', unitId: 'u2', provider: 'grok' }),
    ]
    const t = task({ attempts })
    expect(attempts.map((a) => labelFor(t, a))).toEqual([CHEF_LABEL, 'codex-1', 'codex-2', 'grok-1'])
  })

  it('worker 依 startedAt 排序編號,不依 attempts 陣列順序', () => {
    const later = attempt({ id: 'later', unitId: 'u2', provider: 'codex', startedAt: 20 })
    const earlier = attempt({ id: 'earlier', unitId: 'u2', provider: 'codex', startedAt: 10 })
    const t = task({ attempts: [later, earlier] })
    expect(labelFor(t, later)).toBe('codex-2')
    expect(labelFor(t, earlier)).toBe('codex-1')
  })

  it('unit 找不到時當成主廚,不丟例外', () => {
    expect(labelFor(task(), attempt({ unitId: '不存在' }))).toBe(CHEF_LABEL)
  })
})

describe('標題', () => {
  it('超過 60 字就截斷', () => {
    expect(titleOf('x'.repeat(80))).toHaveLength(60)
    expect(titleOf('短目標')).toBe('短目標')
    expect(titleOf('  兩側空白  ')).toBe('兩側空白')
  })
  it('截斷時不切開 emoji 的代理對', () => {
    const prefix = 'x'.repeat(59)
    expect(titleOf(`${prefix}🎯`)).toBe(`${prefix}🎯`)
  })
  it('general 的標題是未分派', () => {
    expect(GENERAL_TITLE).toBe('未分派')
  })
})

describe('共用發話者標籤', () => {
  it('主行程與 renderer 共用你、系統與 agent label', () => {
    expect(USER_LABEL).toBe('你')
    expect(SYSTEM_LABEL).toBe('系統')
    expect(senderLabel({ kind: 'user' })).toBe(USER_LABEL)
    expect(senderLabel({ kind: 'system' })).toBe(SYSTEM_LABEL)
    expect(senderLabel({ kind: 'agent', conversationId: 'c1', label: 'codex-1', provider: 'codex', role: 'worker' })).toBe('codex-1')
  })
})

describe('MSG', () => {
  it('每一則都是繁體中文,不含內部名稱與破折號', () => {
    const rendered = [
      MSG.injection('你'), MSG.mentionNotFound(['bob']), MSG.busy('codex-1'), MSG.threadOpened('補測試'),
      MSG.noProject, MSG.noChef, MSG.noModels, MSG.startFailed('忙碌中'), MSG.noConversation('codex-1'), MSG.participantLeft('codex-1'),
      MSG.delegated('實作', 'code'), MSG.joined('codex-1', '實作', 'gpt-5'), MSG.left('codex-1', '額度用完'),
      MSG.unitDone('codex-1', '實作'), MSG.unitBlocked('codex-1', '實作', '缺權限'),
      MSG.taskReport('completed', '做完了'), MSG.chefPrompt,
      ...Object.values(GROUP_UI_TEXT).flatMap((value) => typeof value === 'string' ? [value] : Object.values(value)),
      ...Object.values(LEFT_PANE_UI_TEXT),
    ]
    for (const text of rendered) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/--|—|TODO/)
      expect(text).not.toMatch(/GROUP_UI_TEXT|LEFT_PANE_UI_TEXT|GROUP_ALL_THREADS|GROUP_CHANNEL/)
    }
  })

  it('renderer 與主廚服務不就地寫入使用者或系統發話標籤', async () => {
    const sources = await Promise.all([
      readFile(new URL('../src/renderer/components/GroupPane.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/main/chef/service.ts', import.meta.url), 'utf8'),
    ])
    for (const source of sources) {
      expect(source).not.toContain("'你'")
      expect(source).not.toContain("'系統'")
    }
  })

  it('幾則關鍵訊息的內容', () => {
    expect(MSG.injection('你')).toBe('[群組 · 你]')
    expect(MSG.mentionNotFound(['bob', 'eve'])).toContain('bob、eve')
    expect(MSG.busy('codex-1')).toBe('codex-1 正在工作中,訊息已送出')
    expect(MSG.threadOpened('補測試')).toContain('補測試')
    expect(MSG.delegated('實作', 'code')).toBe('主廚把「實作」交給 code 的工作者')
    expect(MSG.joined('codex-1', '實作', 'gpt-5')).toBe('codex-1 加入,負責「實作」,用 gpt-5')
    expect(MSG.unitDone('codex-1', '實作')).toBe('codex-1 完成「實作」')
    expect(MSG.unitBlocked('codex-1', '實作', '缺權限')).toBe('codex-1 卡在「實作」:缺權限。在這個目標裡回覆即可接續')
    // 需要核對時群組回覆不會接續（群組只會提示去主廚視窗），提示不能寫成回覆即可。
    expect(MSG.unitBlocked('codex-1', '實作', '舊執行者尚未確認停止', true)).toBe('codex-1 卡在「實作」:舊執行者尚未確認停止。核對工作目錄後，按群組下方的「確認後接續」')
    expect(MSG.taskEnded('blocked', '已停止；仍有工具結果需要核對', true)).toBe('任務已暫停:已停止；仍有工具結果需要核對。核對工作目錄後，按群組下方的「確認後接續」')
    // 原因本身已以句號結尾時不能再補一個（實機出現過「進度已保存。。」）。
    expect(MSG.reconciliationRequired('已停止；仍有工具結果需要核對，進度已保存。')).toBe('任務卡住：已停止；仍有工具結果需要核對，進度已保存。舊執行者可能留下沒核對的工具結果，核對工作目錄後，按群組下方的「確認後接續」')
    expect(MSG.reconciliationRequired('需核對')).toBe('任務卡住：需核對。舊執行者可能留下沒核對的工具結果，核對工作目錄後，按群組下方的「確認後接續」')
    expect(MSG.taskEnded('cancelled', '已達任務期限')).toBe('任務已停止:已達任務期限。在這個目標裡回覆即可接續')
    expect(MSG.taskReport('completed', '做完了')).toBe('任務完成:做完了')
    expect(MSG.taskReport('blocked', '缺授權')).toBe('任務卡住:缺授權')
    expect(MSG.startFailed('工作目錄已有執行中的任務')).toBe('開新目標失敗:工作目錄已有執行中的任務')
    expect(MSG.startFailed('')).toBe('開新目標失敗:原因不明')
    expect(MSG.participantLeft('codex-1')).toBe('codex-1 已經離開這個目標,訊息沒有送出')
    expect(MSG.chefPrompt).toContain('say_to_group')
    expect(MSG.chefPrompt).toContain('task_progress')
  })

  it('過長的原因文字不會讓群組訊息超過上限', () => {
    const reason = 'x'.repeat(4000)
    for (const text of [
      MSG.startFailed(reason),
      MSG.left('codex-1', reason),
      MSG.unitBlocked('codex-1', '實作', reason),
      MSG.taskReport('blocked', reason),
    ]) {
      expect(text.length).toBeLessThanOrEqual(4000)
    }
  })

  it('原因很長時卡住與停止訊息仍保留接續提示', () => {
    const reason = 'x'.repeat(4000)
    const hint = '在這個目標裡回覆即可接續'
    for (const text of [MSG.unitBlocked('codex-1', '實作', reason), MSG.taskEnded('cancelled', reason)]) {
      expect(text.length).toBeLessThanOrEqual(4000)
      expect(text.endsWith(hint)).toBe(true)
    }
  })
})
