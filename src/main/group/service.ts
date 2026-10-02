// src/main/group/service.ts
/**
 * 群組頻道的規則(群組規格 §4、§5、§6)。
 *
 * 記憶體裡的那份是唯一給讀取用的真相,NDJSON 是持久層:`task_progress` 要同步拿到
 * 最近的訊息,不能每次都去讀檔。第一次碰到某個專案時把檔案讀進來,之後只往後接。
 */
import type { ChefTask } from '../../shared/chef.js'
import type { Provider } from '../../shared/projects.js'
import {
  GENERAL_THREAD_ID,
  GROUP_ALL_THREADS,
  GROUP_READ_LIMIT,
  GroupMessageSchema,
  GroupRequestSchema,
  USER_LABEL,
  activeGroupParticipants,
  targetThreadForAll,
  type GroupMessage,
  type GroupMessagesPayload,
  type GroupRequest,
  type GroupResponse,
  type GroupSender,
  type GroupThread,
} from '../../shared/group.js'
import { GENERAL_TITLE, MSG, labelFor, roleOf, titleOf } from './messages.js'
import type { GroupStore } from './store.js'

export type DeliverOutcome = { readonly kind: 'delivered'; readonly busy: boolean } | { readonly kind: 'missing' }

export interface GroupChef {
  tasksOf(projectId: string): readonly ChefTask[]
  /** 實作在 `index.ts`,直接轉呼叫 Task 7 的 `ChefService.start`,不做任何 diff。 */
  start(projectId: string, goal: string): Promise<{ readonly kind: 'ok'; readonly taskId: string } | { readonly kind: 'error'; readonly message: string }>
  /** 已停止任務的群組補充訊息走 chef 的 resume action。 */
  resume(taskId: string, message: string): Promise<{ readonly kind: 'ok' } | { readonly kind: 'error'; readonly message: string }>
}

export interface GroupMessageInput {
  readonly projectId: string
  readonly threadId: string
  readonly from: GroupSender
  readonly kind: GroupMessage['kind']
  readonly text: string
  readonly unitId?: string
}

export interface OpenParticipantInput {
  readonly projectId: string
  readonly provider: Provider
  readonly sessionId: string
  readonly tabLabel: string
}

export interface GroupServiceDeps {
  readonly store: GroupStore
  readonly chef: GroupChef
  readonly deliver: (projectId: string, conversationId: string, text: string) => DeliverOutcome
  readonly openParticipant: (input: OpenParticipantInput) => void
  readonly hasProject: (projectId: string) => boolean
  readonly onChange: (payload: GroupMessagesPayload) => void
  readonly newId: () => string
  readonly now: () => number
  readonly logError: (error: Error) => void
}

export interface GroupService {
  handle(raw: unknown): Promise<GroupResponse>
  /** 里程碑與 `say_to_group` 用。同步呼叫,寫入失敗只 logError,不往外拋。 */
  write(input: GroupMessageInput): void
  /**
   * `task_progress` 用。先確保這個專案的訊息已經從 store 載進來,再從記憶體那份取:
   * 直接讀檔會漏掉剛寫下、還沒落地的里程碑,只讀記憶體則會漏掉重開 app 之前的訊息。
   */
  recent(projectId: string, threadId: string, limit: number): Promise<readonly GroupMessage[]>
  threadsOf(projectId: string): readonly GroupThread[]
  dispose(): Promise<void>
}

/** 找不到 participant label 時,用原本的詞元規則取得要回報的名稱。 */
const MENTION_FALLBACK = /^([\w\u4e00-\u9fff-]{1,40})/u

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function mentionsIn(text: string, labels: readonly string[]): { hits: string[]; misses: string[] } {
  const hits: string[] = []
  const misses: string[] = []
  for (const marker of text.matchAll(/@/g)) {
    const suffix = text.slice((marker.index ?? 0) + 1)
    const label = labels
      .filter((candidate) => suffix.startsWith(candidate))
      .reduce((longest, candidate) => candidate.length > longest.length ? candidate : longest, '')
    if (label.length > 0) {
      hits.push(label)
      continue
    }
    const missing = suffix.match(MENTION_FALLBACK)?.[1]
    if (missing !== undefined) misses.push(missing)
  }
  return { hits, misses }
}

export function createGroupService(deps: GroupServiceDeps): GroupService {
  /** projectId 到那個專案的訊息。載入過的才在裡面。 */
  let cache = new Map<string, readonly GroupMessage[]>()
  let loadedProjects = new Set<string>()
  let loadingProjects = new Map<string, Promise<void>>()
  let pending = new Map<string, readonly GroupMessage[]>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const messagesOf = (projectId: string): readonly GroupMessage[] => cache.get(projectId) ?? []

  const flush = (): void => {
    timer = undefined
    const batch = pending
    pending = new Map()
    for (const [projectId, messages] of batch) {
      try {
        deps.onChange({ projectId, messages: [...messages], threads: [...threadsOf(projectId)] })
      } catch (cause) {
        deps.logError(cause instanceof Error ? cause : new Error(`群組訊息推播失敗:${projectId}`, { cause }))
      }
    }
  }

  const schedule = (): void => {
    if (closed || timer !== undefined) return
    timer = setTimeout(flush, 0)
    timer.unref?.()
  }

  /** 唯一的寫入點:進快取、排推播、落檔。落檔失敗只記 log。 */
  const record = (input: GroupMessageInput, mentions: readonly string[] = [], deliveredMentions: readonly string[] = []): GroupMessage | undefined => {
    const message: GroupMessage = {
      id: deps.newId(),
      projectId: input.projectId,
      threadId: input.threadId,
      at: deps.now(),
      from: input.from,
      kind: input.kind,
      text: input.text,
      mentions: [...mentions],
      ...(deliveredMentions.length === 0 ? {} : { deliveredMentions: [...deliveredMentions] }),
      ...(input.unitId === undefined ? {} : { unitId: input.unitId }),
    }
    const parsed = GroupMessageSchema.safeParse(message)
    if (!parsed.success) {
      deps.logError(new Error('群組訊息格式不正確', { cause: parsed.error }))
      return undefined
    }
    const validMessage = parsed.data
    cache = new Map([...cache, [validMessage.projectId, [...messagesOf(validMessage.projectId), validMessage].slice(-GROUP_READ_LIMIT)]])
    pending = new Map([...pending, [validMessage.projectId, [...(pending.get(validMessage.projectId) ?? []), validMessage]]])
    schedule()
    deps.store.append(validMessage).catch((cause: unknown) => {
      deps.logError(new Error(`群組訊息寫入失敗:${validMessage.projectId}`, { cause }))
    })
    return validMessage
  }

  const ensureLoaded = async (projectId: string): Promise<void> => {
    if (loadedProjects.has(projectId)) return
    const inFlight = loadingProjects.get(projectId)
    if (inFlight !== undefined) return inFlight
    const loading = (async () => {
      const loaded = await deps.store.read(projectId).catch((cause: unknown) => {
        deps.logError(new Error(`群組訊息讀取失敗:${projectId}`, { cause }))
        return [] as readonly GroupMessage[]
      })
      if (!loadedProjects.has(projectId)) {
        const messagesById = new Map([...loaded, ...messagesOf(projectId)].map((message) => [message.id, message]))
        cache = new Map([...cache, [projectId, [...messagesById.values()].slice(-GROUP_READ_LIMIT)]])
        loadedProjects = new Set([...loadedProjects, projectId])
      }
    })()
    loadingProjects = new Map([...loadingProjects, [projectId, loading]])
    try {
      await loading
    } finally {
      if (loadingProjects.get(projectId) === loading) {
        loadingProjects = new Map([...loadingProjects].filter(([id]) => id !== projectId))
      }
    }
  }

  function threadsOf(projectId: string): readonly GroupThread[] {
    const general: GroupThread = { id: GENERAL_THREAD_ID, title: GENERAL_TITLE, status: 'open', createdAt: 0, holdsWorkspace: false, participants: [] }
    const tasks = deps.chef.tasksOf(projectId).map((task) => ({
      id: task.id,
      title: titleOf(task.goal),
      status: task.status,
      createdAt: task.createdAt,
      holdsWorkspace: ['queued', 'running', 'stopping'].includes(task.status) || task.needsReconciliation,
      participants: task.attempts.map((attempt) => {
        const unitTitle = task.units.find((u) => u.id === attempt.unitId)?.title
        return {
          label: labelFor(task, attempt),
          conversationId: attempt.workerId,
          ...(attempt.sessionId === undefined ? {} : { sessionId: attempt.sessionId }),
          provider: attempt.provider,
          role: roleOf(task, attempt),
          ...(unitTitle === undefined ? {} : { unitTitle }),
        }
      }),
    }))
    return [general, ...tasks]
  }

  const openParticipant = (projectId: string, threadId: string, conversationId: string): GroupResponse => {
    const task = deps.chef.tasksOf(projectId).find((candidate) => candidate.id === threadId)
    const attempt = task?.attempts.find((candidate) => candidate.workerId === conversationId)
    const unit = task?.units.find((candidate) => candidate.id === attempt?.unitId)
    if (task === undefined || attempt?.sessionId === undefined || unit === undefined) {
      return { kind: 'error', message: MSG.closedConversationHint }
    }
    deps.openParticipant({
      projectId,
      provider: attempt.provider,
      sessionId: attempt.sessionId,
      tabLabel: `${labelFor(task, attempt)} · ${unit.title}`,
    })
    return { kind: 'opened' }
  }

  /** general 或還沒有主廚的 thread:開一個新任務,人那則訊息直接掛在新 taskId 上(規格 §6)。 */
  const openGoal = async (projectId: string, text: string): Promise<GroupResponse> => {
    const started = await deps.chef.start(projectId, text)
    if (started.kind === 'error') {
      record({ projectId, threadId: GENERAL_THREAD_ID, from: { kind: 'user' }, kind: 'text', text })
      record({ projectId, threadId: GENERAL_THREAD_ID, from: { kind: 'system' }, kind: 'text', text: started.message })
      return { kind: 'sent', threadId: GENERAL_THREAD_ID }
    }
    record({ projectId, threadId: started.taskId, from: { kind: 'user' }, kind: 'goal', text })
    record({ projectId, threadId: started.taskId, from: { kind: 'system' }, kind: 'text', text: MSG.threadOpened(titleOf(text)) })
    return { kind: 'sent', threadId: started.taskId }
  }

  const resumeTask = async (projectId: string, task: ChefTask, threadId: string, kind: GroupMessage['kind'], text: string, mentions: readonly string[]): Promise<GroupResponse> => {
    record({ projectId, threadId, from: { kind: 'user' }, kind, text }, mentions)
    let explanation: string
    if (task.needsReconciliation) explanation = MSG.reconciliationRequired(task.reason)
    else {
      try {
        const resumed = await deps.chef.resume(task.id, text)
        explanation = resumed.kind === 'ok' ? MSG.taskResuming : MSG.resumeFailed(resumed.message)
      } catch (cause) { explanation = MSG.resumeFailed(toError(cause).message) }
    }
    record({ projectId, threadId, from: { kind: 'system' }, kind: 'text', text: explanation })
    return { kind: 'sent', threadId }
  }

  /** 前置檢查失敗(專案不在、開不了新目標)才不寫訊息;寫進去之後一律回 sent(規格 §5)。 */
  const send = async (projectId: string, threadId: string, text: string): Promise<GroupResponse> => {
    await ensureLoaded(projectId)
    const threads = threadsOf(projectId)
    const resolvedThread = threadId === GROUP_ALL_THREADS ? targetThreadForAll(threads) : undefined
    const targetId = resolvedThread?.id ?? (threadId === GROUP_ALL_THREADS ? GENERAL_THREAD_ID : threadId)
    const thread = threads.find((candidate) => candidate.id === targetId)
    if (thread === undefined) return openGoal(projectId, text)
    const targetThreadId = thread.id
    const task = deps.chef.tasksOf(projectId).find((candidate) => candidate.id === targetThreadId), canResume = task !== undefined && ['blocked', 'cancelled'].includes(task.status)
    const chefSeat = thread?.participants.find((p) => p.role === 'chef')
    if (chefSeat === undefined && !canResume) return openGoal(projectId, text)
    const { hits, misses } = mentionsIn(text, thread.participants.map((participant) => participant.label))
    const kind = messagesOf(projectId).some((m) => m.threadId === targetThreadId) ? 'text' : 'goal'
    const mentions = [...new Set([...hits, ...misses])].slice(0, 10)
    // 有叫不到的名字就誰都不送:寧可讓人改一次,也不要猜他想找誰(規格 §5.1)。
    if (misses.length > 0) {
      record({ projectId, threadId: targetThreadId, from: { kind: 'user' }, kind, text }, mentions)
      record({ projectId, threadId: targetThreadId, from: { kind: 'system' }, kind: 'text', text: MSG.mentionNotFound(misses) })
      return { kind: 'sent', threadId: targetThreadId }
    }
    const mentioned = mentions.flatMap((label) => {
      const participant = thread.participants.find((candidate) => candidate.label === label)
      return participant === undefined ? [] : [participant]
    })
    if (canResume && task !== undefined && (
      mentions.length === 0 || (mentions.length === 1 && mentioned[0]?.role === 'chef')
    )) return resumeTask(projectId, task, targetThreadId, kind, text, mentions)
    const active = new Set(activeGroupParticipants(thread, messagesOf(projectId)).map((participant) => participant.conversationId))
    const left = mentioned.filter((participant) => !active.has(participant.conversationId))
    const recipients = mentions.length === 0 ? (chefSeat === undefined ? [] : [chefSeat]) : mentioned.filter((participant) => active.has(participant.conversationId))
    const deliveredMentions: string[] = []
    const warnings: string[] = left.map((participant) => MSG.participantLeft(participant.label))
    for (const target of recipients) {
      let outcome: DeliverOutcome | undefined
      try {
        outcome = deps.deliver(projectId, target.conversationId, `${MSG.injection(USER_LABEL)}\n${text}`)
      } catch (cause) {
        deps.logError(cause instanceof Error ? cause : new Error('群組訊息送達失敗', { cause }))
      }
      if (outcome?.kind === 'delivered') {
        if (target.role === 'worker') deliveredMentions.push(target.label)
        if (outcome.busy) warnings.push(MSG.busy(target.label))
      } else {
        warnings.push(MSG.noConversation(target.label))
      }
    }
    record({ projectId, threadId: targetThreadId, from: { kind: 'user' }, kind, text }, mentions, deliveredMentions)
    for (const warning of warnings) record({ projectId, threadId: targetThreadId, from: { kind: 'system' }, kind: 'text', text: warning })
    return { kind: 'sent', threadId: targetThreadId }
  }

  return {
    async handle(raw) {
      let request: GroupRequest
      try {
        request = GroupRequestSchema.parse(raw)
      } catch (cause) {
        deps.logError(toError(cause))
        return { kind: 'error', message: MSG.badRequest }
      }
      try {
        if (closed) throw new Error('群組服務已停止')
        if (!deps.hasProject(request.projectId)) return { kind: 'error', message: MSG.noProject }
        if (request.action === 'get') {
          await ensureLoaded(request.projectId)
          return { kind: 'state', messages: [...messagesOf(request.projectId)], threads: [...threadsOf(request.projectId)] }
        }
        if (request.action === 'openParticipant') {
          return openParticipant(request.projectId, request.threadId, request.conversationId)
        }
        return await send(request.projectId, request.threadId, request.text)
      } catch (cause) {
        deps.logError(cause instanceof Error ? cause : new Error('群組操作失敗', { cause }))
        return { kind: 'error', message: MSG.badRequest }
      }
    },

    write(input) {
      if (closed) return
      try {
        record(input)
      } catch (cause) {
        deps.logError(new Error('群組里程碑寫入失敗', { cause }))
      }
    },

    async recent(projectId, threadId, limit) {
      await ensureLoaded(projectId)
      return messagesOf(projectId).filter((m) => m.threadId === threadId).slice(-limit)
    },

    threadsOf,

    async dispose() {
      closed = true
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      pending = new Map()
      await deps.store.dispose()
    },
  }
}
