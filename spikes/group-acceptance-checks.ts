import type { CdpConnection } from './group-acceptance-cdp.js'
import { CHECK_TIMEOUT_MS, SHORT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, clipped, delay, goalTitle, initializeProject, launchApp, closeApp, waitFor, type AppRun, type RuntimeContext } from './group-acceptance-runtime.js'
import { activeProjectState, click, clickThreadFilter, conversationSnapshot, ensureGroupVisible, groupDomSnapshot, jumpTo, returnToGroup, typeAndEnter, visibleGroup, type ConversationSnapshot } from './group-acceptance-ui.js'
import { currentCodexWorker, expectedGroupRows, groupDetail, groupDomRowsEqual, hasVisibleGroupText, inputTurnCountsByParticipant, messageSignature, participantsWithNewInputTurn, readGroup, readTasks, taskById, taskSummary, type ChefTask, type CurrentCodexWorker, type GroupDomRow, type GroupMessage } from './group-acceptance-state.js'

function workerLifecycle(messages: readonly GroupMessage[], unitId: string): readonly GroupMessage[] {
  return messages.filter((message) => message.unitId === unitId && (message.kind === 'joined' || message.kind === 'left') &&
    message.from.kind === 'agent' && message.from.role === 'worker')
}

function latestCodexJoin(messages: readonly GroupMessage[], unitId: string, worker: CurrentCodexWorker): GroupMessage | undefined {
  return [...messages].reverse().find((message) => message.unitId === unitId && message.kind === 'joined' &&
    message.from.kind === 'agent' && message.from.role === 'worker' && message.from.provider === 'codex' &&
    message.from.conversationId === worker.conversationId)
}

async function waitForVisibleGroupTexts(page: CdpConnection, texts: readonly string[], target: string): Promise<readonly GroupDomRow[]> {
  return waitFor(target, SHORT_TIMEOUT_MS, async () => {
    const rows = await groupDomSnapshot(page)
    const missing = texts.filter((text) => !hasVisibleGroupText(rows, text))
    return missing.length === 0
      ? { done: true, value: rows, detail: `visible=${texts.length} rows=${rows.length}` }
      : { done: false, detail: `visible=${texts.length - missing.length}/${texts.length} missing=${JSON.stringify(missing.map((text) => clipped(text, 80)))}` }
  })
}

function latestGroupState(messages: readonly GroupMessage[], task: ChefTask | undefined): string {
  const latest = messages.slice(-5).map((message) => ({ kind: message.kind, from: message.from.label ?? message.from.kind, at: message.at, text: clipped(message.text, 90) }))
  return JSON.stringify({ task: taskSummary(task), latest })
}

async function targetMessages(ctx: RuntimeContext): Promise<{ readonly messages: readonly GroupMessage[]; readonly threadId: string }> {
  return waitFor('新目標訊息、開目標通知與主廚 joined', CHECK_TIMEOUT_MS, async () => {
    const messages = await readGroup(ctx)
    const goalMessage = messages.find((message) => message.kind === 'goal' && message.text === ctx.goal)
    if (goalMessage === undefined) return { done: false, detail: latestGroupState(messages, undefined) }
    ctx.threadId = goalMessage.threadId
    ctx.taskId = goalMessage.threadId
    const threadMessages = messages.filter((message) => message.threadId === goalMessage.threadId)
    const opened = threadMessages.find((message) => message.from.kind === 'system' && message.text.includes('開了新目標'))
    const chefJoined = threadMessages.find((message) => message.kind === 'joined' && message.from.kind === 'agent' && message.from.role === 'chef')
    const task = taskById(await readTasks(ctx), goalMessage.threadId)
    const detail = JSON.stringify({ goal: groupDetail(goalMessage), opened: groupDetail(opened), chefJoined: groupDetail(chefJoined), task: taskSummary(task) })
    return opened !== undefined && chefJoined !== undefined
      ? { done: true, value: { messages, threadId: goalMessage.threadId }, detail }
      : { done: false, detail }
  })
}

async function clickAndReadChef(ctx: RuntimeContext, page: CdpConnection): Promise<{ readonly replyTurns: number; readonly reply: string; readonly jumped: boolean }> {
  const joined = (await readGroup(ctx)).find((message) => message.threadId === ctx.threadId && message.kind === 'joined' && message.from.role === 'chef')
  if (joined?.from.label === undefined || joined.from.conversationId === undefined) throw new Error('主廚 joined 訊息沒有標籤或 conversationId')
  ctx.chefId = joined.from.conversationId
  await ensureGroupVisible(page)
  await jumpTo(page, joined.from.label)
  const snapshot = await waitFor('主廚對話出現 assistant turn', CHECK_TIMEOUT_MS, async () => {
    const state = await conversationSnapshot(page)
    const turns = state.turns.filter((turn) => turn.role === 'assistant' && turn.text.trim() !== '')
    return turns.length > 0
      ? { done: true, value: { state, turns }, detail: `mode=${state.mode} assistantTurns=${turns.length} last=${clipped(turns.at(-1)?.text ?? '')}` }
      : { done: false, detail: `mode=${state.mode} assistantTurns=${turns.length}` }
  })
  const active = await waitFor('主廚 conversationId 成為前景分頁', SHORT_TIMEOUT_MS, async () => {
    const state = await activeProjectState(ctx)
    const activeTabId = state?.activeTabId
    return activeTabId === ctx.chefId
      ? { done: true, value: true, detail: `activeTabId=${activeTabId}` }
      : { done: false, detail: `activeTabId=${activeTabId ?? 'missing'} expected=${ctx.chefId}` }
  })
  await returnToGroup(page)
  return { replyTurns: snapshot.turns.length, reply: clipped(snapshot.turns.at(-1)?.text ?? ''), jumped: active }
}

export async function checkOne(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const page = ctx.currentApp!.page!
  await waitFor('renderer 專案分頁列', SHORT_TIMEOUT_MS, async () => {
    const ready = await page.evaluate<boolean>('Boolean(document.querySelector(".tab-strip") && document.querySelector(".pane-area"))')
    return { done: ready, value: undefined, detail: `tabStrip=${ready}` }
  })
  await click(page, '.tab[role="tab"][data-provider="group"]')
  await waitFor('群組 pane 與輸入框', SHORT_TIMEOUT_MS, async () => {
    const ready = await page.evaluate<boolean>(`Array.from(document.querySelectorAll('.group-pane textarea')).some(el => el.getAttribute('aria-label') === '對群組說話')`)
    return { done: ready, value: undefined, detail: `groupComposer=${ready}` }
  })
  await typeAndEnter(page, '.group-input[aria-label="對群組說話"]', ctx.goal)
  const target = await targetMessages(ctx)
  const task = taskById(await readTasks(ctx), ctx.taskId)
  const providers = new Set(task?.policy.allowed.map((key) => key.split(':', 1)[0]) ?? [])
  const poolOk = providers.has('claude') && providers.has('codex') && !providers.has('grok') && [...providers].every((provider) => provider === 'claude' || provider === 'codex')
  ctx.modelPoolSafe = poolOk
  const chef = target.messages.find((message) => message.threadId === ctx.threadId && message.kind === 'joined' && message.from.role === 'chef')
  const opened = target.messages.find((message) => message.threadId === ctx.threadId && message.from.kind === 'system' && message.text.includes('開了新目標'))
  const visibleRows = await waitForVisibleGroupTexts(page, [opened?.text ?? '', chef?.text ?? ''], '開目標與主廚 joined 出現在 renderer')
  const openedVisible = opened !== undefined && hasVisibleGroupText(visibleRows, opened.text)
  const joinedVisible = chef !== undefined && hasVisibleGroupText(visibleRows, chef.text)
  const response = await clickAndReadChef(ctx, page)
  const detail = JSON.stringify({ opened: groupDetail(opened), openedVisible, joined: groupDetail(chef), joinedVisible, policyAllowedProviders: [...providers], mainConversation: { id: ctx.chefId, assistantTurns: response.replyTurns, lastReply: response.reply, foregroundJump: response.jumped } })
  return { ok: poolOk && chef !== undefined && opened !== undefined && openedVisible && joinedVisible && response.replyTurns > 0 && response.jumped, detail }
}

async function waitForCodexWorker(ctx: RuntimeContext): Promise<{
  readonly message: GroupMessage
  readonly worker: CurrentCodexWorker | undefined
  readonly task: ChefTask
  readonly messages: readonly GroupMessage[]
  readonly unitId: string
}> {
  return waitFor('同一 delegated unit 結束並確定目前 Codex worker', CHECK_TIMEOUT_MS, async () => {
    const [allMessages, tasks] = await Promise.all([readGroup(ctx), readTasks(ctx)])
    const messages = allMessages.filter((message) => message.threadId === ctx.threadId)
    const delegated = messages.find((message) => message.threadId === ctx.threadId && message.kind === 'delegated')
    const task = taskById(tasks, ctx.taskId)
    const unitId = delegated?.unitId
    const worker = unitId === undefined ? undefined : currentCodexWorker(messages, unitId)
    const unit = task?.units.find((candidate) => candidate.id === unitId)
    const unitEnded = unit !== undefined && ['done', 'blocked'].includes(unit.status)
    const lifecycle = unitId === undefined ? [] : workerLifecycle(messages, unitId)
    const joined = worker === undefined || unitId === undefined ? undefined : latestCodexJoin(messages, unitId, worker)
    const lastCodexJoin = unitEnded
      ? [...lifecycle].reverse().find((message) => message.kind === 'joined' && message.from.kind === 'agent' && message.from.provider === 'codex')
      : undefined
    const message = joined ?? lastCodexJoin
    const detail = JSON.stringify({ delegated: groupDetail(delegated), currentWorker: worker, joinedLeftChain: lifecycle.map(groupDetail), unit, task: taskSummary(task) })
    if (task === undefined || unitId === undefined || message === undefined || !unitEnded) {
      return { done: false, detail }
    }
    return { done: true, value: { message, worker, task, messages, unitId }, detail }
  })
}

export async function checkTwo(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (ctx.threadId === undefined) throw new Error('#1 沒有建立 thread，無法驗收委派')
  const page = ctx.currentApp!.page!
  const { message, worker, task, messages, unitId } = await waitForCodexWorker(ctx)
  const delegated = messages.find((item) => item.kind === 'delegated' && item.unitId === unitId)
  const targetId = worker?.conversationId ?? message.from.conversationId
  const label = worker?.label ?? message.from.label
  if (targetId === undefined || label === undefined) throw new Error('Codex joined 沒有 worker ID 或畫面標籤')
  ctx.workerUnitId = unitId
  ctx.workerId = targetId
  if (worker !== undefined) {
    ctx.codexId = worker.conversationId
    ctx.codexLabel = worker.label
  }
  const rootUnitIds = new Set(task.units.filter((unit) => unit.parentId === null || unit.kind === 'review').map((unit) => unit.id))
  ctx.chefRoundsAtWorkerJoin = task.attempts.filter((attempt) => rootUnitIds.has(attempt.unitId) && attempt.startedAt <= message.at).length
  await ensureGroupVisible(page)
  const milestoneRows = await waitForVisibleGroupTexts(page, [delegated?.text ?? '', message.text], 'delegated 與 worker joined 出現在 renderer')
  const delegatedVisible = delegated !== undefined && hasVisibleGroupText(milestoneRows, delegated.text)
  const joinedVisible = hasVisibleGroupText(milestoneRows, message.text)
  await jumpTo(page, label)
  const foreground = await waitFor('worker conversationId 成為 activeTabId', SHORT_TIMEOUT_MS, async () => {
    const state = await activeProjectState(ctx)
    const selected = await page.evaluate<string>('document.querySelector(".tab[role=tab][aria-selected=true]")?.getAttribute("data-provider") ?? "missing"')
    const ok = state?.activeTabId === targetId && selected === 'codex'
    return { done: ok, value: ok, detail: `activeTabId=${state?.activeTabId ?? 'missing'} expected=${targetId} selectedProvider=${selected}` }
  })
  await returnToGroup(page)
  const joinedLeftChain = workerLifecycle(messages, unitId).map(groupDetail)
  return { ok: delegated !== undefined && delegatedVisible && joinedVisible && message.kind === 'joined' && message.from.provider === 'codex' && message.from.role === 'worker' && foreground, detail: JSON.stringify({ delegated: groupDetail(delegated), delegatedVisible, joined: groupDetail(message), joinedVisible, joinedLeftChain, currentWorker: worker, chefRoundsAtJoin: ctx.chefRoundsAtWorkerJoin, foregroundTab: { id: targetId, label, provider: 'codex', changed: foreground } }) }
}

export async function checkThree(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (ctx.threadId === undefined || ctx.workerUnitId === undefined) throw new Error('#2 沒有找到 Codex worker unit，無法驗收 say_to_group')
  const workerUnitId = ctx.workerUnitId
  const selected = await waitFor('目前 Codex worker 的 say_to_group text 訊息', CHECK_TIMEOUT_MS, async () => {
    const messages = (await readGroup(ctx)).filter((item) => item.threadId === ctx.threadId)
    const worker = currentCodexWorker(messages, workerUnitId)
    const joined = worker === undefined ? undefined : latestCodexJoin(messages, workerUnitId, worker)
    const found = worker === undefined || joined === undefined ? undefined : [...messages].reverse().find((item) =>
      item.kind === 'text' && item.unitId === workerUnitId && item.from.kind === 'agent' && item.from.role === 'worker' &&
      item.from.conversationId === worker.conversationId && item.at >= joined.at)
    if (worker === undefined || joined === undefined || found === undefined) {
      return { done: false, detail: JSON.stringify({ currentWorker: worker, joined: groupDetail(joined), latest: latestGroupState(messages, taskById(await readTasks(ctx), ctx.taskId)) }) }
    }
    return { done: true, value: { message: found, worker }, detail: JSON.stringify({ currentWorker: worker, sayToGroup: groupDetail(found) }) }
  })
  const { message, worker } = selected
  ctx.codexId = worker.conversationId
  ctx.codexLabel = worker.label
  const task = taskById(await readTasks(ctx), ctx.taskId)
  if (task === undefined) throw new Error('say_to_group 出現時找不到 ChefTask')
  const roundsAtSay = task.attempts.filter((attempt) => {
    const unit = task.units.find((candidate) => candidate.id === attempt.unitId)
    return (unit?.parentId === null || unit?.kind === 'review') && attempt.startedAt <= message.at
  }).length
  const rootBusyAtSay = task.attempts.some((attempt) => {
    const unit = task.units.find((candidate) => candidate.id === attempt.unitId)
    return (unit?.parentId === null || unit?.kind === 'review') && attempt.startedAt <= message.at && (attempt.endedAt === undefined || attempt.endedAt >= message.at)
  })
  const rows = await waitForVisibleGroupTexts(ctx.currentApp!.page!, [message.text], 'worker say_to_group 出現在 renderer')
  const visible = hasVisibleGroupText(rows, message.text)
  const ok = ctx.chefRoundsAtWorkerJoin !== undefined && roundsAtSay === ctx.chefRoundsAtWorkerJoin && !rootBusyAtSay && visible
  return { ok, detail: JSON.stringify({ currentWorker: worker, sayToGroup: groupDetail(message), visible, chefRoundsAtJoined: ctx.chefRoundsAtWorkerJoin, chefRoundsAtSayTimestamp: roundsAtSay, rootChefBusyAtSayTimestamp: rootBusyAtSay, task: taskSummary(task) }) }
}

async function waitForUnitDone(ctx: RuntimeContext): Promise<ChefTask> {
  if (ctx.workerUnitId === undefined) throw new Error('#2 沒有記錄 delegated unit')
  const workerUnitId = ctx.workerUnitId
  return waitFor('Codex delegated unit 的 progress milestone 與 done 狀態', CHECK_TIMEOUT_MS, async () => {
    const [messages, tasks] = await Promise.all([readGroup(ctx), readTasks(ctx)])
    const task = taskById(tasks, ctx.taskId)
    const workerUnit = task?.units.find((unit) => unit.id === workerUnitId)
    const done = messages.find((message) => message.threadId === ctx.threadId && message.kind === 'progress' && message.unitId === workerUnitId)
    const detail = JSON.stringify({ progress: groupDetail(done), task: taskSummary(task) })
    return task !== undefined && workerUnit?.status === 'done' && done !== undefined
      ? { done: true, value: task, detail }
      : { done: false, detail }
  })
}

export async function sendCodexMention(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (ctx.threadId === undefined || ctx.workerUnitId === undefined) {
    throw new Error('#2 沒有找到 delegated unit，無法送出 @ 訊息')
  }
  const page = ctx.currentApp!.page!
  const task = await waitForUnitDone(ctx)
  const messages = (await readGroup(ctx)).filter((message) => message.threadId === ctx.threadId)
  const worker = currentCodexWorker(messages, ctx.workerUnitId)
  if (worker === undefined) throw new Error('delegated unit 結束後沒有目前的 Codex worker')
  const codexId = worker.conversationId
  const codexLabel = worker.label
  ctx.codexId = codexId
  ctx.codexLabel = codexLabel
  await ensureGroupVisible(page)
  await clickThreadFilter(page, goalTitle(ctx))
  const before = await conversationSnapshotAfterJump(ctx, page, codexLabel)
  await returnToGroup(page)
  const input = `@${codexLabel} [group-acceptance ${ctx.runId}] 請在這個對話簡短回覆我，不要用 say_to_group。`
  const beforeMessages = await readGroup(ctx)
  const wasAlreadyPresent = beforeMessages.some((message) => message.text === input)
  await typeAndEnter(page, '.group-input[aria-label="對群組說話"]', input)
  const delivered = await waitFor('群組 @ 訊息含實際 Codex label', SHORT_TIMEOUT_MS, async () => {
    const messages = await readGroup(ctx)
    const user = messages.find((message) => message.threadId === ctx.threadId && message.from.kind === 'user' && message.text === input && message.mentions.includes(codexLabel))
    return user === undefined
      ? { done: false, detail: latestGroupState(messages, taskById(await readTasks(ctx), ctx.taskId)) }
      : { done: true, value: user, detail: groupDetail(user) }
  })
  const response = await waitForCodexReply(ctx, page, delivered.at, before.turns.length, input)
  const afterMessages = await readGroup(ctx)
  const echo = afterMessages.find((message) => message.threadId === ctx.threadId && message.from.kind === 'agent' && message.from.conversationId === codexId && message.kind === 'text' && message.at >= delivered.at)
  await returnToGroup(page)
  const visibleRows = await waitForVisibleGroupTexts(page, [input], 'Codex @ 訊息出現在 renderer')
  const directMessageVisible = hasVisibleGroupText(visibleRows, input)
  return {
    ok: delivered.mentions.includes(codexLabel) && !wasAlreadyPresent && directMessageVisible && response.found && response.idle && echo === undefined,
    detail: JSON.stringify({ delivered: groupDetail(delivered), directMessageVisible, currentWorker: worker, codexConversation: { id: codexId, assistantTurnsBefore: before.turns.length, response: clipped(response.reply), modeAtEnd: response.mode, idleAtEnd: response.idle }, groupEcho: groupDetail(echo), task: taskSummary(task) }),
  }
}

async function conversationSnapshotAfterJump(ctx: RuntimeContext, page: CdpConnection, label: string): Promise<ConversationSnapshot> {
  await jumpTo(page, label)
  const state = await waitFor('worker 前景 conversation DOM 可讀', SHORT_TIMEOUT_MS, async () => {
    const value = await conversationSnapshot(page)
    const active = await activeProjectState(ctx)
    const activeTabId = active?.activeTabId
    const isActive = activeTabId === ctx.codexId
    return isActive && value.mode !== ''
      ? { done: true, value, detail: `activeTabId=${activeTabId} mode=${value.mode} turns=${value.turns.length}` }
      : { done: false, detail: `activeTabId=${activeTabId ?? 'missing'} mode=${value.mode}` }
  })
  return state
}

async function waitForCodexReply(
  ctx: RuntimeContext,
  page: CdpConnection,
  deliveredAt: number,
  previousTurns: number,
  input: string,
): Promise<{ readonly found: boolean; readonly idle: boolean; readonly reply: string; readonly mode: string }> {
  await jumpTo(page, ctx.codexLabel!)
  return waitFor('Codex assistant 回覆並進入準備就緒', CHECK_TIMEOUT_MS, async () => {
    const state = await conversationSnapshot(page)
    const userIndex = state.turns.findIndex((turn) => turn.role === 'user' && turn.text.includes(input))
    const response = userIndex < 0 ? undefined : state.turns.slice(userIndex + 1).find((turn) => turn.role === 'assistant' && turn.text.trim() !== '')
    const foreground = await activeProjectState(ctx)
    const idle = state.mode === '準備就緒' && foreground?.activeTabId === ctx.codexId
    const found = response !== undefined && state.turns.length > previousTurns
    const detail = JSON.stringify({ inputTurnFound: userIndex >= 0, assistantTurns: state.turns.length, assistantReply: clipped(response?.text ?? ''), mode: state.mode, foreground: foreground?.activeTabId, deliveredAt })
    return found && idle
      ? { done: true, value: { found, idle, reply: response.text, mode: state.mode }, detail }
      : { done: false, detail }
  })
}

export async function checkSix(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (ctx.threadId === undefined || ctx.taskId === undefined) throw new Error('#1 沒有建立 ChefTask，無法驗收里程碑')
  const task = await waitForUnitDone(ctx)
  const reviewResult = await waitFor('主廚 review 回報或結束', CHECK_TIMEOUT_MS, async () => {
    const [messages, tasks] = await Promise.all([readGroup(ctx), readTasks(ctx)])
    const current = taskById(tasks, ctx.taskId)
    const reviewUnit = current?.units.find((unit) => unit.kind === 'review')
    const reviewAttempt = current?.attempts.filter((attempt) => attempt.unitId === reviewUnit?.id).at(-1)
    const blockedMessage = messages.find((message) => message.threadId === ctx.threadId && message.kind === 'blocked' && message.from.kind === 'agent' && message.from.role === 'chef' && message.unitId === reviewUnit?.id)
    const reportMessage = messages.find((message) => message.threadId === ctx.threadId && message.kind === 'report' && message.from.kind === 'agent' && message.from.role === 'chef')
    const completeMessage = messages.find((message) => message.threadId === ctx.threadId && message.kind === 'progress' && message.unitId !== undefined)
    const terminal = current !== undefined && (reviewUnit?.status === 'blocked' || reviewUnit?.status === 'done' || ['completed', 'blocked', 'cancelled'].includes(current.status))
    const detail = JSON.stringify({ complete: groupDetail(completeMessage), blocked: groupDetail(blockedMessage), report: groupDetail(reportMessage), reviewUnit, reviewAttempt, task: taskSummary(current) })
    return terminal
      ? { done: true, value: { current, reviewUnit, reviewAttempt, blockedMessage, reportMessage }, detail }
      : { done: false, detail }
  })
  const completion = (await readGroup(ctx)).find((message) => message.threadId === ctx.threadId && message.kind === 'progress' && message.from.kind === 'agent' && message.from.role === 'worker' && message.unitId !== undefined)
  const persisted = taskById(await readTasks(ctx), ctx.taskId) ?? reviewResult.current
  const reviewUnit = persisted?.units.find((unit) => unit.kind === 'review')
  const blockedMessage = reviewResult.blockedMessage
  const doneUnit = persisted?.units.find((unit) => unit.id === completion?.unitId && unit.status === 'done')
  const page = ctx.currentApp!.page!
  const visibleMessages = [completion?.text, blockedMessage?.text].filter((text): text is string => text !== undefined)
  await ensureGroupVisible(page)
  const rows = await waitForVisibleGroupTexts(page, visibleMessages, '完成與 review 結果出現在 renderer')
  const completionVisible = completion !== undefined && hasVisibleGroupText(rows, completion.text)
  const blockedVisible = blockedMessage !== undefined && hasVisibleGroupText(rows, blockedMessage.text)
  const reviewBlocked = reviewUnit?.status === 'blocked' && blockedMessage?.unitId === reviewUnit.id
  const detail = JSON.stringify({ completedMilestone: groupDetail(completion), completionVisible, completedUnit: doneUnit, expectedReview: 'blocked', actualReview: { unit: reviewUnit, attempt: reviewResult.reviewAttempt, report: persisted?.report, blockedMilestone: groupDetail(blockedMessage), reportMilestone: groupDetail(reviewResult.reportMessage), visible: blockedVisible }, task: taskSummary(persisted), intentionallyImpossiblePath: `/proc/yeschef-group-${ctx.runId}` })
  return { ok: completion !== undefined && doneUnit !== undefined && reviewBlocked && completionVisible && blockedVisible, detail: `${detail}; earlier wait task=${taskSummary(task)}` }
}

export async function checkFive(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const page = ctx.currentApp!.page!
  if (ctx.threadId === undefined || ctx.taskId === undefined || ctx.chefId === undefined || ctx.codexId === undefined || ctx.codexLabel === undefined) {
    throw new Error('目標或已驗證參與者尚未建立')
  }
  await ensureGroupVisible(page)
  await clickThreadFilter(page, goalTitle(ctx))
  const tasksBefore = await readTasks(ctx)
  const taskBefore = taskById(tasksBefore, ctx.taskId)
  const text = `@不存在的人 [group-acceptance ${ctx.runId}] 這句話不可送給任何人。`
  await typeAndEnter(page, '.group-input[aria-label="對群組說話"]', text)
  const [user, warning] = await waitFor('不存在的 @ 警告訊息', SHORT_TIMEOUT_MS, async () => {
    const messages = await readGroup(ctx)
    const sent = messages.find((message) => message.threadId === ctx.threadId && message.from.kind === 'user' && message.text === text)
    const system = sent === undefined ? undefined : messages.find((message) => message.threadId === ctx.threadId && message.from.kind === 'system' && message.at >= sent.at && message.text.includes('訊息沒有送給任何人') && message.text.includes('不存在的人'))
    const detail = JSON.stringify({ user: groupDetail(sent), system: groupDetail(system), latest: messages.slice(-4).map((message) => groupDetail(message)) })
    return sent !== undefined && system !== undefined
      ? { done: true, value: [sent, system] as const, detail }
      : { done: false, detail }
  })
  const visibleRows = await waitForVisibleGroupTexts(page, [warning.text], '找不到 mention 的警告出現在 renderer')
  const warningVisible = hasVisibleGroupText(visibleRows, '訊息沒有送給任何人') && hasVisibleGroupText(visibleRows, '不存在的人')
  await delay(400)
  const taskFinal = taskById(await readTasks(ctx), ctx.taskId)
  const inputRecipients = participantsWithNewInputTurn(taskBefore, taskFinal, text)
  const noConversationDelivery = taskBefore !== undefined && taskFinal !== undefined && inputRecipients.length === 0
  const taskStable = taskBefore?.attempts.length === taskFinal?.attempts.length && taskBefore?.status === taskFinal?.status
  return { ok: user.threadId === ctx.threadId && warning.from.kind === 'system' && warningVisible && noConversationDelivery, detail: JSON.stringify({ user: groupDetail(user), warning: groupDetail(warning), warningVisible, attemptsBefore: taskBefore?.attempts.length, attemptsAfter: taskFinal?.attempts.length, statusBefore: taskBefore?.status, statusAfter: taskFinal?.status, taskStable, conversationsBefore: inputTurnCountsByParticipant(taskBefore, text), conversationsAfter: inputTurnCountsByParticipant(taskFinal, text), inputRecipients, noConversationDelivery }) }
}

async function waitForFilteredRows(page: CdpConnection, messages: readonly GroupMessage[], target: string): Promise<readonly GroupDomRow[]> {
  return waitFor(target, SHORT_TIMEOUT_MS, async () => {
    const rows = await groupDomSnapshot(page)
    const expected = expectedGroupRows(messages)
    const exact = groupDomRowsEqual(rows, expected)
    return exact
      ? { done: true, value: rows, detail: `rows=${rows.length} exact=true` }
      : { done: false, detail: `expected=${expected.length} rendered=${rows.length} exact=false` }
  })
}

async function filterThreadBeforeRestart(ctx: RuntimeContext, page: CdpConnection): Promise<{ readonly all: readonly GroupMessage[]; readonly filtered: readonly GroupDomRow[]; readonly allRows: number }> {
  const messagesBefore = await readGroup(ctx)
  const threadMessages = messagesBefore.filter((message) => message.threadId === ctx.threadId)
  const snapshotBefore = await groupDomSnapshot(page)
  await clickThreadFilter(page, goalTitle(ctx))
  const filtered = await waitForFilteredRows(page, threadMessages, '關閉前 thread filter rows 與持久化訊息相同')
  return { all: messagesBefore, filtered, allRows: snapshotBefore.length }
}

async function restartAndLoadGroup(ctx: RuntimeContext, firstApp: AppRun): Promise<{ readonly app: AppRun; readonly messages: readonly GroupMessage[] }> {
  await closeApp(ctx, firstApp)
  const restarted = await launchApp(ctx)
  await initializeProject(ctx)
  const restartedPage = restarted.page
  if (restartedPage === undefined) throw new Error(`重啟 Electron pid=${restarted.pid} 沒有 renderer CDP 連線`)
  await waitFor('重啟 renderer 顯示已存的群組分頁', SHORT_TIMEOUT_MS, async () => {
    const exists = await restartedPage.evaluate<boolean>('Boolean(document.querySelector(".tab[role=tab][data-provider=group]"))')
    return { done: exists, value: undefined, detail: `groupTab=${exists}` }
  })
  await ensureGroupVisible(restartedPage)
  const persisted = await waitFor('重啟後群組 NDJSON 與 renderer rows 重載', STARTUP_TIMEOUT_MS, async () => {
    const [messages, visible] = await Promise.all([readGroup(ctx), visibleGroup(restartedPage)])
    const paneText = visible ? await groupDomSnapshot(restartedPage) : []
    const same = messageSignature(messages).join('\n') === (ctx.beforeRestart ?? []).join('\n')
    const rendered = groupDomRowsEqual(paneText, expectedGroupRows(messages))
    return same && visible && rendered
      ? { done: true, value: messages, detail: `messages=${messages.length} pane=${visible} rows=${paneText.length} rendered=${rendered}` }
      : { done: false, detail: `messages=${messages.length} expected=${ctx.beforeRestart?.length ?? 0} pane=${visible} rows=${paneText.length} rendered=${rendered}` }
  })
  return { app: restarted, messages: persisted }
}

export async function checkSeven(ctx: RuntimeContext): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (ctx.threadId === undefined) throw new Error('#1 沒有建立 thread，無法驗收重啟')
  const firstApp = ctx.currentApp
  if (firstApp?.page === undefined) throw new Error('Electron renderer 已經關閉')
  await ensureGroupVisible(firstApp.page)
  const before = await filterThreadBeforeRestart(ctx, firstApp.page)
  ctx.beforeRestart = messageSignature(before.all)
  const after = await restartAndLoadGroup(ctx, firstApp)
  const restartedPage = after.app.page
  if (restartedPage === undefined) throw new Error(`重啟 Electron pid=${after.app.pid} 沒有 renderer CDP 連線`)
  await clickThreadFilter(restartedPage, goalTitle(ctx))
  const expected = after.messages.filter((message) => message.threadId === ctx.threadId)
  const filteredAfter = await waitForFilteredRows(restartedPage, expected, '重啟後相同 thread filter rows 重現')
  const exactFilter = JSON.stringify(filteredAfter) === JSON.stringify(before.filtered)
  const threadCount = expected.length
  return {
    ok: after.messages.length === ctx.beforeRestart?.length && threadCount === before.filtered.length && exactFilter,
    detail: JSON.stringify({ userDataDir: ctx.userData, pidBeforeRestart: firstApp.pid, pidAfterRestart: after.app.pid, persistedMessagesBefore: ctx.beforeRestart?.length, persistedMessagesAfter: after.messages.length, threadId: ctx.threadId, threadMessages: threadCount, allRowsBeforeFilter: before.allRows, filteredRowsBefore: before.filtered.length, filteredRowsAfter: filteredAfter.length, exactVisibleRows: exactFilter, firstAt: after.messages[0]?.at, lastAt: after.messages.at(-1)?.at }),
  }
}
