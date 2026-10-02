/**
 * 群組頻道的共用型別(群組規格 §3、§7)。main 與 renderer 都 import,
 * 所以不引入 Electron 與 node 內建模組。
 */
import { z } from 'zod'
import { isNonEmptyString, isRecord } from './ipc.js'
import { providerSchema } from './projects.js'

export const GROUP_CHANNEL = 'group:manage'
/** 還沒變成目標的訊息都掛在這條 thread 上,永遠存在,排在最前面。 */
export const GENERAL_THREAD_ID = 'general'
/** renderer 選取「全部」時交由主行程解析的 thread 哨兵。 */
export const GROUP_ALL_THREADS = '__all_threads__'
export const GROUP_MESSAGE_TEXT_MAX = 4000
export const USER_LABEL = '你'
export const SYSTEM_LABEL = '系統'
/** 讀取只取最後這麼多則(規格 §3.2)。 */
export const GROUP_READ_LIMIT = 2000
/** `task_progress` 回傳的群組訊息則數與每則的字數上限(規格 §4.3)。 */
export const GROUP_PROGRESS_LIMIT = 20
export const GROUP_PROGRESS_TEXT_MAX = 300
/** 任務收尾的里程碑只帶摘要的前這麼多字(規格 §4.2)。 */
export const GROUP_REPORT_TEXT_MAX = 500

export const GroupSenderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
  z.object({
    kind: z.literal('agent'),
    conversationId: z.string().min(1),
    label: z.string().min(1).max(40),
    provider: providerSchema,
    role: z.enum(['chef', 'worker']),
  }).strict(),
])
export type GroupSender = z.infer<typeof GroupSenderSchema>

export function senderLabel(from: GroupSender): string {
  return from.kind === 'agent' ? from.label : from.kind === 'user' ? USER_LABEL : SYSTEM_LABEL
}

export const GroupMessageKindSchema = z.enum(['text', 'goal', 'delegated', 'progress', 'report', 'blocked', 'joined', 'left'])
export type GroupMessageKind = z.infer<typeof GroupMessageKindSchema>

export const GroupMessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  threadId: z.string().min(1),
  at: z.number().int().nonnegative(),
  from: GroupSenderSchema,
  kind: GroupMessageKindSchema,
  text: z.string().max(GROUP_MESSAGE_TEXT_MAX),
  mentions: z.array(z.string().max(40)).max(10),
  deliveredMentions: z.array(z.string().max(40)).max(10).optional(),
  unitId: z.string().optional(),
}).strict()
export type GroupMessage = z.infer<typeof GroupMessageSchema>

/** 一般發言以外的都是里程碑,畫面用不同的底色與字級區隔(規格 §8)。 */
export function isMilestone(message: GroupMessage): boolean {
  return message.kind !== 'text' && message.kind !== 'goal'
}

export const GroupParticipantSchema = z.object({
  label: z.string().min(1).max(40),
  conversationId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  provider: providerSchema,
  role: z.enum(['chef', 'worker']),
  unitTitle: z.string().optional(),
}).strict()
export type GroupParticipant = z.infer<typeof GroupParticipantSchema>

export const GroupThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** `open` 是 general 專用;其餘與 `ChefTask['status']` 逐字相同。 */
  status: z.enum(['open', 'queued', 'running', 'stopping', 'completed', 'blocked', 'cancelled']),
  /** 對應 `ChefTask.createdAt`;general 固定 0。選「全部」時送訊息要靠它挑最新的進行中目標。 */
  createdAt: z.number().int().nonnegative(),
  /** 任務仍持有工作目錄;包含正在執行與需要核對的卡住任務。 */
  holdsWorkspace: z.boolean().default(false),
  participants: z.array(GroupParticipantSchema),
}).strict()
export type GroupThread = z.infer<typeof GroupThreadSchema>

/** 同一 thread 裡最後一則 participant 里程碑不是 left 的成員。 */
export function activeGroupParticipants(thread: GroupThread, messages: readonly GroupMessage[]): GroupParticipant[] {
  const latestMilestone = new Map<string, GroupMessageKind>()
  for (const message of messages) {
    if (message.threadId !== thread.id || message.from.kind !== 'agent') continue
    if (message.kind !== 'joined' && message.kind !== 'left') continue
    latestMilestone.set(message.from.conversationId, message.kind)
  }
  return thread.participants.filter((participant) => latestMilestone.get(participant.conversationId) !== 'left')
}

/** 「全部」送訊息與 @ 建議共用的 thread 預覽規則。 */
export function targetThreadForAll(threads: readonly GroupThread[]): GroupThread | undefined {
  const latest = (candidates: readonly GroupThread[]): GroupThread | undefined => candidates.reduce<GroupThread | undefined>(
      (latest, thread) => latest === undefined || thread.createdAt > latest.createdAt ? thread : latest,
      undefined
    )
  const active = latest(threads.filter((thread) => ['running', 'queued', 'stopping'].includes(thread.status)))
  const blocked = latest(threads.filter((thread) => thread.status === 'blocked' && thread.holdsWorkspace))
  // 權限被拒而卡住的任務不佔工作目錄,但最新一個任務卡住時,使用者在「全部」打的字多半是要它繼續;
  // 較舊的卡住任務不搶訊息,否則舊任務會永遠擋住開新目標。
  const newest = latest(threads.filter((thread) => thread.id !== GENERAL_THREAD_ID))
  const newestBlocked = newest?.status === 'blocked' ? newest : undefined
  return active ?? blocked ?? newestBlocked ?? threads.find((thread) => thread.id === GENERAL_THREAD_ID)
}

export const GroupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), projectId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('send'),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    action: z.literal('openParticipant'),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    conversationId: z.string().min(1),
  }).strict(),
])
export type GroupRequest = z.infer<typeof GroupRequestSchema>

export const GroupResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), messages: z.array(GroupMessageSchema), threads: z.array(GroupThreadSchema) }).strict(),
  z.object({ kind: z.literal('sent'), threadId: z.string() }).strict(),
  z.object({ kind: z.literal('opened') }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])
export type GroupResponse = z.infer<typeof GroupResponseSchema>

/** `group:messages` 的 payload:訊息批次與當下整份 thread 清單(規格 §7)。 */
export const GroupMessagesPayloadSchema = z.object({
  projectId: z.string().min(1),
  messages: z.array(GroupMessageSchema),
  threads: z.array(GroupThreadSchema),
}).strict()
export type GroupMessagesPayload = z.infer<typeof GroupMessagesPayloadSchema>

export function parseGroupMessagesPayload(raw: unknown): GroupMessagesPayload | null {
  const result = GroupMessagesPayloadSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** `group:open` 的 payload:只有專案 id,分頁 id 由主行程產。 */
export interface GroupOpenPayload {
  readonly projectId: string
}

export function parseGroupOpen(raw: unknown): GroupOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  return { projectId: raw['projectId'] }
}

/** `say_to_group` 的參數(規格 §4.1)。 */
export const SayToGroupSchema = z.object({ text: z.string().min(1).max(2000) }).strict()
