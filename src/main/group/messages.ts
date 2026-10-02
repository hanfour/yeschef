/**
 * 群組頻道給人看的字(群組規格 §9)與參與者名字的算法(§3.1)。
 *
 * label 在寫入訊息時就算好並存進去,之後 attempt 增減都不會改動歷史訊息上的名字。
 */
import type { ChefAttempt, ChefTask } from '../../shared/chef.js'
import { GROUP_MESSAGE_TEXT_MAX, GROUP_REPORT_TEXT_MAX } from '../../shared/group.js'

export const CHEF_LABEL = '主廚'
export const GENERAL_TITLE = '未分派'
export const TITLE_MAX = 60

function boundedMessage(prefix: string, content: string): string {
  return `${prefix}${content.slice(0, Math.max(0, GROUP_MESSAGE_TEXT_MAX - prefix.length))}`
}

function boundedWithSuffix(prefix: string, content: string, suffix: string): string {
  const contentLength = Math.max(0, GROUP_MESSAGE_TEXT_MAX - prefix.length - suffix.length)
  return `${prefix}${content.slice(0, contentLength)}${suffix}`
}

/** 原因本身可能已經以句號結尾，接下一句前只補一個句號。 */
function endSentence(text: string): string {
  return text.endsWith('。') ? '' : '。'
}

/** 群組分頁在卡住且需要核對的任務下方顯示「確認後接續」按鈕，提示文字指向它。 */
const RECONCILE_HINT = '核對工作目錄後，按群組下方的「確認後接續」'

/** 需要核對的任務在群組回覆不會接續，提示要跟實際行為一致。 */
function resumeHint(reason: string, needsReconciliation: boolean): string {
  return `${endSentence(reason)}${needsReconciliation ? RECONCILE_HINT : '在這個目標裡回覆即可接續'}`
}

export const MSG = {
  injection: (label: string) => `[群組 · ${label}]`,
  mentionNotFound: (names: readonly string[]) => boundedMessage(
    '群組裡沒有 ',
    `${names.slice(0, 5).join('、')}${names.length > 5 ? ` 等 ${names.length - 5} 個` : ''},訊息沒有送給任何人`
  ),
  busy: (label: string) => `${label} 正在工作中,訊息已送出`,
  threadOpened: (goal: string) => `開了新目標:${goal},主廚即將就位`,
  noProject: '找不到這個專案',
  badRequest: '訊息格式不正確',
  noChef: '主廚服務沒有啟動,現在開不了新目標',
  noModels: '沒有可用的模型,請先在主廚控制台重新整理模型',
  startFailed: (reason: string) => boundedMessage('開新目標失敗:', reason || '原因不明'),
  noConversation: (label: string) => `${label} 的對話已經關閉`,
  closedConversationHint: '這段對話的分頁已關閉，可從歷史側欄開啟',
  participantLeft: (label: string) => boundedMessage(`${label} 已經離開這個目標,`, '訊息沒有送出'),
  taskResuming: '任務接續中，主廚會讀到你這則訊息',
  reconciliationRequired: (reason: string) => boundedWithSuffix(
    '任務卡住：',
    reason,
    `${endSentence(reason)}舊執行者可能留下沒核對的工具結果，${RECONCILE_HINT}`
  ),
  resumeFailed: (reason: string) => boundedMessage('任務接續失敗：', reason || '原因不明'),
  delegated: (title: string, kind: string) => `主廚把「${title}」交給 ${kind} 的工作者`,
  joined: (label: string, unitTitle: string, model: string, reasoningEffort?: string) => `${label} 加入,負責「${unitTitle}」,用 ${model}${reasoningEffort === undefined ? '' : `,推理強度 ${reasoningEffort}`}`,
  left: (label: string, reason: string) => boundedMessage(`${label} 離開:`, reason),
  unitDone: (label: string, unitTitle: string) => `${label} 完成「${unitTitle}」`,
  unitBlocked: (label: string, unitTitle: string, reason: string, needsReconciliation = false) => boundedWithSuffix(
    `${label} 卡在「${unitTitle}」:`,
    reason,
    resumeHint(reason, needsReconciliation)
  ),
  taskEnded: (status: 'blocked' | 'cancelled', reason: string, needsReconciliation = false) => boundedWithSuffix(
    status === 'cancelled' ? '任務已停止:' : '任務已暫停:',
    reason,
    resumeHint(reason, needsReconciliation)
  ),
  deadlineExtended: (minutes: number, reason: string) => boundedMessage(`主廚把期限延長 ${minutes} 分鐘：`, reason),
  deadlineNotExtended: (reason: string) => boundedMessage('主廚判斷不延長期限：', reason),
  deadlineReviewFailed: '期限延長判斷失敗，到期會停止',
  taskReport: (outcome: 'completed' | 'blocked', summary: string) => boundedMessage(
    `任務${outcome === 'completed' ? '完成' : '卡住'}:`,
    summary.slice(0, GROUP_REPORT_TEXT_MAX)
  ),
  chefPrompt: '這個任務在專案群組裡進行。用 say_to_group 對人與其他工作者說話,用 task_progress 看群裡發生什麼。',
} as const

/** 跟 `ChefService.worker()` 同一條規則:根 unit 與 review unit 是主廚,其餘是工作者。 */
export function roleOf(task: ChefTask, attempt: ChefAttempt): 'chef' | 'worker' {
  const unit = task.units.find((candidate) => candidate.id === attempt.unitId)
  return unit === undefined || unit.parentId === null || unit.kind === 'review' ? 'chef' : 'worker'
}

/** 主廚固定叫「主廚」;worker 叫 `<provider>-<序號>`,序號只數同一家的 worker attempt。 */
export function labelFor(task: ChefTask, attempt: ChefAttempt): string {
  if (roleOf(task, attempt) === 'chef') return CHEF_LABEL
  const sameProvider = task.attempts
    .filter((candidate) => candidate.provider === attempt.provider && roleOf(task, candidate) === 'worker')
    .sort((left, right) => left.startedAt - right.startedAt)
  const index = sameProvider.findIndex((candidate) => candidate.id === attempt.id)
  return `${attempt.provider}-${index < 0 ? sameProvider.length + 1 : index + 1}`
}

export function titleOf(goal: string): string {
  return Array.from(goal.trim()).slice(0, TITLE_MAX).join('')
}
