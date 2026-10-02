# 子專案 5a 第一階段:同伴問答的機制與工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同一個專案裡的兩個 Claude 對話可以互相提問:一方呼叫 `ask_peer` 阻塞等待,另一方收到注入的提問、呼叫 `answer_peer` 回覆,答案回到提問方的工具結果。

**Architecture:** `src/main/peer/` 五個檔各一個責任:`message.ts` 是訊息型別與建構(純函式),`mailbox.ts` 管 `<project>/.yeschef/mail/` 的檔案佈局與三檔狀態判定,`registry.ts` 記活著的同伴並解析 `to`,`service.ts` 是 `ask_peer`／`answer_peer` 的實作(未決檢查、死鎖、注入排隊、逾時、行程內喚醒、重啟取消),`errors.ts` 集中訊息。兩個工具掛在 B 既有的程序內 MCP server(每個對話一份),`ipc-bridge.ts` 負責把每個對話登錄進 registry 並提供「送一則文字進去」與「回合結束了」兩個接點。

**Tech Stack:** Electron 44、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4、`@anthropic-ai/claude-agent-sdk` 0.3.258 的 `createSdkMcpServer`／`tool`、zod 4.5.4(只在 main)。

**Spec:** `docs/specs/2026-09-09-yeschef-peer-design.md`。本計畫做 §8 的 5a 裡「信箱、兩個工具、注入、逾時、死鎖、重啟取消」;§6.2 的畫面(同伴提問自成一輪、等待秒數、重播合併)與 §6.5 的人的介入留給第二階段,§8 的 5c(codex 接線)留給第三階段。

## Global Constraints

- 一則訊息一個檔案,檔名都用 question 的 id:`question-<id>.json`、`answer-<id>.json`、`cancel-<id>.json`。狀態由三個檔案的存在與否決定,沒有另外的狀態欄位(規格 §3.1)。
- 寫檔用暫存檔加 rename,與狀態檔同一套;`<userData>/yeschef-mail/<projectId>/` 是副本,每次寫主檔成功後同步寫一份,副本寫失敗只記錯誤。讀取以專案內的信箱為準,專案內整個目錄不存在才用副本,不逐檔混用兩邊(規格 §3.1)。
- 壞檔一律記錯誤並略過,不刪:question 檔壞掉那筆視為不存在;終態檔壞掉那個問題視為未決,由逾時收掉;`answer` 檔壞掉不等逾時,立刻寫 cancel(原因「答案檔損毀」)(規格 §3.1、§6.3、§7)。
- 逾時 10 分鐘:`deadlineAt = createdAt + 600_000`。掃描每 5 秒一次,時鐘可注入(規格 §6.3)。
- 同一個 session 同時只能有一個未決問題;第二次 `ask_peer` 直接回錯誤(規格 §4.1)。
- 死鎖只擋一種形狀:B 問 A 時,若 A 有未決問題且 `to` 是 B,不寫檔,直接回 B 錯誤(規格 §6.4)。不做三方以上的環偵測。
- `to` 解析(規格 §5):0 個同伴回錯誤;1 個時省略就是它、有給要對得上;2 個以上 `to` 必填。先比完整 `linkId`,對不上再比前 8 碼(`to` 要剛好 8 碼),前 8 碼對到超過一個回錯誤。所有解析失敗的訊息都列候選(`linkId` 前 8 碼、provider、最近一則使用者訊息前 40 字)。
- 注入的文字固定格式(規格 §6.1):
  ```
  同伴(<provider>,<linkId 前 8 碼>)提問:<question.text>
  用 answer_peer 回答,id 是 <id>。答不出來也要回答「答不出來」加原因,不要不回。
  ```
- 對方回合進行中就排隊,不插隊;回合結束再注入。逾時從 question 寫入時算,不從注入時算(規格 §6.1)。
- 兩個工具都不需要批准:加進 `policy.ts` 的允許清單。
- 使用者可見與模型可見的文字全部集中在 `src/main/peer/errors.ts`,照 `src/main/view-tools/errors.ts` 的 `MSG` 做法。
- 資料不就地修改:純函式一律回新物件;模組私有的 Map 與 Set 沿用既有做法。
- 所有測試檔放 `tests/`;檔案系統與時鐘一律注入,測試不碰真的磁碟、不起真的計時器。
- 覆蓋率門檻沿專案:Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令執行,不用 `&&` 串接,不用 `git add -A`/`.`;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 執行 `npm run typecheck` 與 `npm test` 都要綠才算完成一個 Task;Task 6 之後跑 `npm run test:coverage` 確認門檻。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/main/peer/message.ts` | `PeerMessage`、`PeerRef` 型別;`parsePeerMessage`;`newQuestion`／`newAnswer`／`newCancel` 三個建構函式 |
| `src/main/peer/errors.ts` | 訊息表 `PEER_MSG` 與 `PeerError`(照 `view-tools/errors.ts`) |
| `src/main/peer/mailbox.ts` | 信箱的檔案 IO:原子寫、副本、三檔狀態、掃描、壞檔處理 |
| `src/main/peer/registry.ts` | 活著的同伴登錄與 `to` 解析 |
| `src/main/peer/service.ts` | `askPeer`／`answerPeer`、死鎖、注入排隊、逾時掃描、行程內喚醒、重啟取消 |
| `src/shared/peer-tools.ts` | 兩個工具的名稱常數(main 與 renderer 都可能用) |
| `tests/peer-message.test.ts`、`tests/peer-mailbox.test.ts`、`tests/peer-registry.test.ts`、`tests/peer-service.test.ts` | 各自的單元測試 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/main/view-tools/policy.ts` | 允許清單加兩個工具 |
| `src/main/view-tools/server.ts` | `forProject(isActive, peer?)`;有 peer 就多掛兩個工具 |
| `src/main/ipc-bridge.ts` | 每個對話登錄進 registry;`onBusyChange` 順便通知 service |
| `src/main/index.ts` | 建 peer service,接給 `runtimeFor` 與 `createIpcBridge` |

---

### Task 1: 同伴訊息的型別與建構

**Files:**
- Create: `src/main/peer/message.ts`
- Create: `src/main/peer/errors.ts`
- Create: `src/shared/peer-tools.ts`
- Test: `tests/peer-message.test.ts`

**Interfaces:**
- Produces:
  - `interface PeerRef { linkId: string; provider: Provider }`
  - `type PeerKind = 'question' | 'answer' | 'cancel'`
  - `type PeerActor = 'session' | 'user' | 'host'`
  - `interface PeerMessage { id, kind, from, to, actor, inReplyTo, text, createdAt, deadlineAt }`
  - `QUESTION_TIMEOUT_MS = 600_000`
  - `newQuestion(args: { id, from, to, text, now }): PeerMessage`
  - `newAnswer(args: { id, question, text, actor, now }): PeerMessage`
  - `newCancel(args: { id, question, reason, actor, now, swap? }): PeerMessage`
  - `parsePeerMessage(raw: unknown): PeerMessage | null`
  - `PEER_MSG`(訊息表)與 `class PeerError extends Error`
  - `PEER_TOOL_NAMES`、`ASK_PEER_TOOL`、`ANSWER_PEER_TOOL`

- [ ] **Step 1: 寫失敗測試**

`tests/peer-message.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  QUESTION_TIMEOUT_MS, newAnswer, newCancel, newQuestion, parsePeerMessage,
  type PeerMessage, type PeerRef,
} from '../src/main/peer/message.js'

const A: PeerRef = { linkId: 'aaaaaaaa-1111', provider: 'claude' }
const B: PeerRef = { linkId: 'bbbbbbbb-2222', provider: 'codex' }

const question = (): PeerMessage => newQuestion({ id: 'q1', from: A, to: B, text: '要用哪個欄位?', now: 1000 })

describe('newQuestion', () => {
  it('欄位齊全,deadlineAt 是 createdAt 加 10 分鐘', () => {
    expect(question()).toEqual({
      id: 'q1', kind: 'question', from: A, to: B, actor: 'session',
      inReplyTo: null, text: '要用哪個欄位?', createdAt: 1000, deadlineAt: 1000 + QUESTION_TIMEOUT_MS,
    })
    expect(QUESTION_TIMEOUT_MS).toBe(600_000)
  })
})

describe('newAnswer', () => {
  it('from／to 與問題相反,inReplyTo 指回問題,沒有 deadline', () => {
    expect(newAnswer({ id: 'a1', question: question(), text: '用 linkId', actor: 'session', now: 2000 })).toEqual({
      id: 'a1', kind: 'answer', from: B, to: A, actor: 'session',
      inReplyTo: 'q1', text: '用 linkId', createdAt: 2000, deadlineAt: null,
    })
  })
  it('人代替回答時 from 仍是被代答的那一方,actor 是 user', () => {
    const m = newAnswer({ id: 'a2', question: question(), text: '我幫他答', actor: 'user', now: 2000 })
    expect(m.from).toEqual(B)
    expect(m.actor).toBe('user')
  })
})

describe('newCancel', () => {
  it('預設方向與 answer 相同(逾時、同伴已結束、重啟、使用者取消)', () => {
    expect(newCancel({ id: 'c1', question: question(), reason: '同伴 10 分鐘內沒有回答', actor: 'host', now: 3000 })).toEqual({
      id: 'c1', kind: 'cancel', from: B, to: A, actor: 'host',
      inReplyTo: 'q1', text: '同伴 10 分鐘內沒有回答', createdAt: 3000, deadlineAt: null,
    })
  })
  it('提問方已結束時方向不換:from 是原問題的 from(規格 §6.5 的表)', () => {
    const m = newCancel({ id: 'c2', question: question(), reason: '提問方已結束', actor: 'host', now: 3000, swap: false })
    expect(m.from).toEqual(A)
    expect(m.to).toEqual(B)
  })
})

describe('parsePeerMessage', () => {
  it('完整的訊息原樣通過,額外欄位被切掉', () => {
    const raw = { ...question(), extra: 1 }
    expect(parsePeerMessage(raw)).toEqual(question())
  })
  it('三種 kind 都認得', () => {
    for (const m of [question(), newAnswer({ id: 'a', question: question(), text: 't', actor: 'session', now: 1 }), newCancel({ id: 'c', question: question(), reason: 'r', actor: 'host', now: 1 })]) {
      expect(parsePeerMessage(JSON.parse(JSON.stringify(m)))).toEqual(m)
    }
  })
  it('缺欄位、型別不符、不認得的 kind 或 actor 都回 null', () => {
    const ok = question()
    expect(parsePeerMessage(null)).toBeNull()
    expect(parsePeerMessage({ ...ok, id: '' })).toBeNull()
    expect(parsePeerMessage({ ...ok, kind: 'notify' })).toBeNull()
    expect(parsePeerMessage({ ...ok, actor: 'robot' })).toBeNull()
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x' } })).toBeNull()
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x', provider: 'gemini' } })).toBeNull()
    expect(parsePeerMessage({ ...ok, text: 42 })).toBeNull()
    expect(parsePeerMessage({ ...ok, createdAt: 'now' })).toBeNull()
    expect(parsePeerMessage({ ...ok, inReplyTo: 5 })).toBeNull()
    expect(parsePeerMessage({ ...ok, deadlineAt: 'later' })).toBeNull()
  })
  it('inReplyTo 與 deadlineAt 允許 null', () => {
    const m = newAnswer({ id: 'a', question: question(), text: 't', actor: 'session', now: 1 })
    expect(parsePeerMessage(JSON.parse(JSON.stringify(m)))?.deadlineAt).toBeNull()
    expect(parsePeerMessage(JSON.parse(JSON.stringify(question())))?.inReplyTo).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-message.test.ts`
Expected: FAIL,`Cannot find module '../src/main/peer/message.js'`

- [ ] **Step 3: 寫工具名稱常數**

`src/shared/peer-tools.ts`:

```ts
/**
 * 同伴問答的兩個工具(P 規格 §4)。它們掛在與右窗格工具同一份 MCP server 上
 * (`VIEW_TOOL_SERVER_NAME`),所以完整名稱共用同一個前綴。
 * main 與 renderer 都會 import,這裡不引入 Electron 也不引入 `src/main/**`。
 */
import { VIEW_TOOL_PREFIX } from './view-tools.js'

export const PEER_TOOL_NAMES = ['ask_peer', 'answer_peer'] as const
export type PeerToolName = (typeof PEER_TOOL_NAMES)[number]

export const ASK_PEER_TOOL = `${VIEW_TOOL_PREFIX}ask_peer`
export const ANSWER_PEER_TOOL = `${VIEW_TOOL_PREFIX}answer_peer`
```

- [ ] **Step 4: 寫訊息表**

`src/main/peer/errors.ts`:

```ts
/**
 * 同伴問答對模型與使用者說的每一句話。照 `view-tools/errors.ts` 的做法集中在一處:
 * 散在各處的字串會慢慢長出兩種語氣,而這些話有一半是模型看的,語氣要一致。
 */

/** 工具回給模型的錯誤。呼叫端接住之後轉成 `isError` 的工具結果。 */
export class PeerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeerError'
  }
}

export interface PeerCandidate {
  readonly linkId: string
  readonly provider: string
  readonly recent: string
}

const renderCandidates = (candidates: readonly PeerCandidate[]): string =>
  candidates.map((c) => `${c.linkId.slice(0, 8)}(${c.provider})${c.recent === '' ? '' : `:${c.recent}`}`).join('、')

export const PEER_MSG = {
  noPeers: '這個專案沒有別的同伴',
  toRequired: (candidates: readonly PeerCandidate[]) =>
    `這個專案有多個同伴,to 要指定一個:${renderCandidates(candidates)}`,
  toUnknown: (to: string, candidates: readonly PeerCandidate[]) =>
    `找不到同伴 ${to};目前有:${renderCandidates(candidates)}`,
  toAmbiguous: (to: string, candidates: readonly PeerCandidate[]) =>
    `${to} 對到多個同伴,請給完整的 id:${renderCandidates(candidates)}`,
  alreadyAsking: (id: string) => `你已經有一個問題在等回答(#${id}),先等它結束`,
  deadlock: (id: string) => `對方正在等你回答 #${id},先回答它`,
  mailboxUnwritable: (reason: string) => `信箱寫不進去:${reason}`,
  /** 以下五句同時是 cancel 檔的 text,寫進信箱當紀錄。使用者主動取消是第二階段的事,那時再加一句。 */
  timedOut: '同伴 10 分鐘內沒有回答',
  peerEnded: '同伴已結束',
  askerEnded: '提問方已結束',
  restarted: '重啟時取消',
  answerCorrupt: '答案檔損毀',
  /** answer_peer 的四種錯誤。 */
  answerUnknown: (id: string) => `找不到問題 #${id}`,
  answerAlready: (id: string) => `問題 #${id} 已經回答過了`,
  answerCancelled: (id: string) => `問題 #${id} 已取消`,
  answerNotYours: (id: string) => `問題 #${id} 不是問你的`,
  answered: '已回答',
  /** 注入給對方的提問。 */
  injection: (provider: string, linkId: string, id: string, text: string) =>
    `同伴(${provider},${linkId.slice(0, 8)})提問:${text}\n用 answer_peer 回答,id 是 ${id}。答不出來也要回答「答不出來」加原因,不要不回。`,
} as const
```

- [ ] **Step 5: 寫訊息型別與建構**

`src/main/peer/message.ts`:

```ts
/**
 * 同伴訊息(P 規格 §3.2)。純資料與純函式,不碰檔案系統。
 *
 * 三種訊息共用一個形狀:`inReplyTo` 把 answer 與 cancel 綁回 question,
 * `deadlineAt` 只有 question 有值。`actor` 記的是「實際寫這則的是誰」,
 * 與 `from`(這則代表誰)分開:人代替對方回答時 `from` 仍是對方,`actor` 是 `user`。
 */
import type { Provider } from '../../shared/projects.js'

export const QUESTION_TIMEOUT_MS = 600_000

export interface PeerRef {
  readonly linkId: string
  readonly provider: Provider
}

export type PeerKind = 'question' | 'answer' | 'cancel'
export type PeerActor = 'session' | 'user' | 'host'

export interface PeerMessage {
  readonly id: string
  readonly kind: PeerKind
  readonly from: PeerRef
  readonly to: PeerRef
  readonly actor: PeerActor
  readonly inReplyTo: string | null
  readonly text: string
  readonly createdAt: number
  readonly deadlineAt: number | null
}

export function newQuestion(args: {
  readonly id: string
  readonly from: PeerRef
  readonly to: PeerRef
  readonly text: string
  readonly now: number
}): PeerMessage {
  return {
    id: args.id,
    kind: 'question',
    from: args.from,
    to: args.to,
    actor: 'session',
    inReplyTo: null,
    text: args.text,
    createdAt: args.now,
    deadlineAt: args.now + QUESTION_TIMEOUT_MS,
  }
}

export function newAnswer(args: {
  readonly id: string
  readonly question: PeerMessage
  readonly text: string
  readonly actor: PeerActor
  readonly now: number
}): PeerMessage {
  return {
    id: args.id,
    kind: 'answer',
    // 答案由被問的那方發出,人代答時也一樣(規格 §6.5:from 沿用原問題的 to)。
    from: args.question.to,
    to: args.question.from,
    actor: args.actor,
    inReplyTo: args.question.id,
    text: args.text,
    createdAt: args.now,
    deadlineAt: null,
  }
}

export function newCancel(args: {
  readonly id: string
  readonly question: PeerMessage
  readonly reason: string
  readonly actor: PeerActor
  readonly now: number
  /** 預設 true(方向與 answer 相同)。「提問方已結束」那一種要給 false(規格 §6.5 的表)。 */
  readonly swap?: boolean
}): PeerMessage {
  const swap = args.swap ?? true
  return {
    id: args.id,
    kind: 'cancel',
    from: swap ? args.question.to : args.question.from,
    to: swap ? args.question.from : args.question.to,
    actor: args.actor,
    inReplyTo: args.question.id,
    text: args.reason,
    createdAt: args.now,
    deadlineAt: null,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseRef(raw: unknown): PeerRef | null {
  if (!isRecord(raw) || !nonEmpty(raw['linkId'])) return null
  const provider = raw['provider']
  if (provider !== 'claude' && provider !== 'codex') return null
  return { linkId: raw['linkId'], provider }
}

/**
 * 信箱檔案進來時的執行期驗證。檔案是我們自己寫的,但可能被手改、被舊版寫過、
 * 或寫到一半斷電,所以每個欄位都要真的檢查。一律回新造的物件,額外欄位在這裡被切掉。
 */
export function parsePeerMessage(raw: unknown): PeerMessage | null {
  if (!isRecord(raw)) return null
  const kind = raw['kind']
  if (kind !== 'question' && kind !== 'answer' && kind !== 'cancel') return null
  const actor = raw['actor']
  if (actor !== 'session' && actor !== 'user' && actor !== 'host') return null
  const from = parseRef(raw['from'])
  const to = parseRef(raw['to'])
  if (from === null || to === null) return null
  if (!nonEmpty(raw['id'])) return null
  if (typeof raw['text'] !== 'string') return null
  if (!finite(raw['createdAt'])) return null
  const inReplyTo = raw['inReplyTo']
  if (inReplyTo !== null && !nonEmpty(inReplyTo)) return null
  const deadlineAt = raw['deadlineAt']
  if (deadlineAt !== null && !finite(deadlineAt)) return null
  return {
    id: raw['id'],
    kind,
    from,
    to,
    actor,
    inReplyTo,
    text: raw['text'],
    createdAt: raw['createdAt'],
    deadlineAt,
  }
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run tests/peer-message.test.ts`
Expected: PASS(9 tests)

- [ ] **Step 7: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/peer/message.ts src/main/peer/errors.ts src/shared/peer-tools.ts tests/peer-message.test.ts
git commit -m "feat: 同伴訊息的型別、建構與訊息表"
```

---

### Task 2: 信箱

**Files:**
- Create: `src/main/peer/mailbox.ts`
- Test: `tests/peer-mailbox.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PeerMessage`、`parsePeerMessage`。
- Produces:
  - `interface MailboxFs { readFile(p: string): Promise<string>; writeFile(p: string, data: string): Promise<void>; rename(from: string, to: string): Promise<void>; readdir(p: string): Promise<readonly string[]>; mkdir(p: string): Promise<void>; exists(p: string): Promise<boolean> }`
  - `nodeMailboxFs: MailboxFs`
  - `type QuestionStatus = 'pending' | 'answered' | 'cancelled'`
  - `interface MailboxEntry { question: PeerMessage; status: QuestionStatus; corruptAnswer: boolean; answer?: PeerMessage; cancel?: PeerMessage }`
  - `interface Mailbox { write(message: PeerMessage): Promise<void>; read(questionId: string): Promise<MailboxEntry | null>; list(): Promise<readonly MailboxEntry[]> }`
  - `createMailbox(deps: { dir: string; mirrorDir: string; fs?: MailboxFs; logError: (e: Error) => void }): Mailbox`
  - `MAIL_DIR_NAME = 'mail'`、`fileNameFor(message: PeerMessage): string`

規格 §3.1 的狀態表由三個檔案決定,不另外存狀態。四種異常都記錯誤:
question 與終態檔同時壞掉的處理各不相同,測試逐條釘住。

- [ ] **Step 1: 寫失敗測試**

`tests/peer-mailbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMailbox, fileNameFor, type MailboxFs } from '../src/main/peer/mailbox.js'
import { newAnswer, newCancel, newQuestion, type PeerMessage, type PeerRef } from '../src/main/peer/message.js'

const A: PeerRef = { linkId: 'aaaaaaaa-1111', provider: 'claude' }
const B: PeerRef = { linkId: 'bbbbbbbb-2222', provider: 'claude' }
const DIR = '/p/alpha/.yeschef/mail'
const MIRROR = '/data/yeschef-mail/p-a'

const q = (id: string, now = 1000): PeerMessage => newQuestion({ id, from: A, to: B, text: `問題 ${id}`, now })

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const ops: string[] = []
  let failWrite: string | null = null
  const fs: MailboxFs = {
    async readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    async writeFile(p, data) {
      if (failWrite !== null && p.startsWith(failWrite)) throw new Error('唯讀')
      ops.push(`write ${p}`)
      files.set(p, data)
    },
    async rename(from, to) {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, v)
      ops.push(`rename ${from} -> ${to}`)
    },
    async readdir(p) {
      const prefix = `${p}/`
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
    },
    async mkdir(p) { ops.push(`mkdir ${p}`) },
    async exists(p) { return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)) },
  }
  return { fs, files, ops, failWriteUnder: (prefix: string) => { failWrite = prefix } }
}

function setup(initial?: Record<string, string>) {
  const m = memFs(initial)
  const errors: string[] = []
  const mailbox = createMailbox({ dir: DIR, mirrorDir: MIRROR, fs: m.fs, logError: (e) => { errors.push(e.message) } })
  return { ...m, errors, mailbox }
}

const put = (files: Record<string, string>, dir: string, msg: PeerMessage): void => {
  files[`${dir}/${fileNameFor(msg)}`] = JSON.stringify(msg)
}

describe('fileNameFor', () => {
  it('三種訊息的檔名都用 question 的 id', () => {
    const question = q('q1')
    expect(fileNameFor(question)).toBe('question-q1.json')
    expect(fileNameFor(newAnswer({ id: 'a1', question, text: 't', actor: 'session', now: 2 }))).toBe('answer-q1.json')
    expect(fileNameFor(newCancel({ id: 'c1', question, reason: 'r', actor: 'host', now: 3 }))).toBe('cancel-q1.json')
  })
})

describe('write', () => {
  it('先寫暫存檔再 rename,主檔與副本各一份', async () => {
    const r = setup()
    await r.mailbox.write(q('q1'))
    expect(r.files.has(`${DIR}/question-q1.json`)).toBe(true)
    expect(r.files.has(`${MIRROR}/question-q1.json`)).toBe(true)
    expect(r.ops.some((o) => o.includes('.tmp'))).toBe(true)
    expect(r.ops.some((o) => o.startsWith(`rename ${DIR}/question-q1.json.tmp`))).toBe(true)
  })

  it('副本寫失敗只記錯誤,主檔照樣成立', async () => {
    const r = setup()
    r.failWriteUnder(MIRROR)
    await r.mailbox.write(q('q1'))
    expect(r.files.has(`${DIR}/question-q1.json`)).toBe(true)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain('副本')
  })

  it('主檔寫失敗往外拋,呼叫端才知道信箱不能用', async () => {
    const r = setup()
    r.failWriteUnder(DIR)
    await expect(r.mailbox.write(q('q1'))).rejects.toThrow('唯讀')
  })
})

describe('read 的狀態判定(規格 §3.1 的表)', () => {
  it('三個檔都沒有:回 null', async () => {
    expect(await setup().mailbox.read('q1')).toBeNull()
  })

  it('只有 question:未決', async () => {
    const files: Record<string, string> = {}
    put(files, DIR, q('q1'))
    const entry = await setup(files).mailbox.read('q1')
    expect(entry?.status).toBe('pending')
    expect(entry?.question.text).toBe('問題 q1')
  })

  it('question 加 answer:已答,帶得出答案', async () => {
    const files: Record<string, string> = {}
    const question = q('q1')
    put(files, DIR, question)
    put(files, DIR, newAnswer({ id: 'a1', question, text: '答案在這', actor: 'session', now: 2000 }))
    const entry = await setup(files).mailbox.read('q1')
    expect(entry?.status).toBe('answered')
    expect(entry?.answer?.text).toBe('答案在這')
  })

  it('question 加 cancel:已取消', async () => {
    const files: Record<string, string> = {}
    const question = q('q1')
    put(files, DIR, question)
    put(files, DIR, newCancel({ id: 'c1', question, reason: '逾時了', actor: 'host', now: 3000 }))
    const entry = await setup(files).mailbox.read('q1')
    expect(entry?.status).toBe('cancelled')
    expect(entry?.cancel?.text).toBe('逾時了')
  })

  it('answer 與 cancel 同時存在:記錯誤,狀態當已取消', async () => {
    const files: Record<string, string> = {}
    const question = q('q1')
    put(files, DIR, question)
    put(files, DIR, newAnswer({ id: 'a1', question, text: 'a', actor: 'session', now: 2000 }))
    put(files, DIR, newCancel({ id: 'c1', question, reason: 'c', actor: 'host', now: 3000 }))
    const r = setup(files)
    expect((await r.mailbox.read('q1'))?.status).toBe('cancelled')
    expect(r.errors.length).toBe(1)
  })

  it('question 檔壞掉:記錯誤,回 null(那筆視為不存在)', async () => {
    const r = setup({ [`${DIR}/question-q1.json`]: '{壞掉' })
    expect(await r.mailbox.read('q1')).toBeNull()
    expect(r.errors.length).toBe(1)
  })

  it('answer 檔壞掉:記錯誤,狀態未決,但 corruptAnswer 是 true', async () => {
    const files: Record<string, string> = {}
    put(files, DIR, q('q1'))
    files[`${DIR}/answer-q1.json`] = '不是 JSON'
    const r = setup(files)
    const entry = await r.mailbox.read('q1')
    expect(entry?.status).toBe('pending')
    expect(entry?.corruptAnswer).toBe(true)
    expect(r.errors.length).toBe(1)
  })

  it('cancel 檔壞掉:記錯誤,狀態未決,corruptAnswer 是 false(由逾時收掉)', async () => {
    const files: Record<string, string> = {}
    put(files, DIR, q('q1'))
    files[`${DIR}/cancel-q1.json`] = '不是 JSON'
    const r = setup(files)
    const entry = await r.mailbox.read('q1')
    expect(entry?.status).toBe('pending')
    expect(entry?.corruptAnswer).toBe(false)
    expect(r.errors.length).toBe(1)
  })
})

describe('list', () => {
  it('列出全部問題,壞的 question 略過並記錯誤', async () => {
    const files: Record<string, string> = {}
    put(files, DIR, q('q1'))
    put(files, DIR, q('q2', 2000))
    files[`${DIR}/question-q3.json`] = '壞的'
    const q4 = q('q4', 4000)
    put(files, DIR, q4)
    put(files, DIR, newAnswer({ id: 'a4', question: q4, text: 'ok', actor: 'session', now: 5000 }))
    const r = setup(files)
    const all = await r.mailbox.list()
    expect(all.map((e) => e.question.id).sort()).toEqual(['q1', 'q2', 'q4'])
    expect(all.find((e) => e.question.id === 'q4')?.status).toBe('answered')
    expect(r.errors.length).toBe(1)
  })

  it('缺 question 的終態檔:記錯誤並略過', async () => {
    const files: Record<string, string> = {}
    const orphan = newAnswer({ id: 'a9', question: q('q9'), text: 'x', actor: 'session', now: 2 })
    put(files, DIR, orphan)
    const r = setup(files)
    expect(await r.mailbox.list()).toEqual([])
    expect(r.errors.length).toBe(1)
  })

  it('目錄不存在:回空陣列,不記錯', async () => {
    const r = setup()
    expect(await r.mailbox.list()).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('專案內的目錄整個不存在時改讀副本,存在就不混用', async () => {
    const mirrorOnly: Record<string, string> = {}
    put(mirrorOnly, MIRROR, q('q1'))
    const r1 = setup(mirrorOnly)
    expect((await r1.mailbox.list()).map((e) => e.question.id)).toEqual(['q1'])

    const both: Record<string, string> = {}
    put(both, DIR, q('q2', 2000))
    put(both, MIRROR, q('q1'))
    const r2 = setup(both)
    expect((await r2.mailbox.list()).map((e) => e.question.id)).toEqual(['q2'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-mailbox.test.ts`
Expected: FAIL,`Cannot find module '../src/main/peer/mailbox.js'`

- [ ] **Step 3: 寫實作**

`src/main/peer/mailbox.ts`:

```ts
/**
 * 同伴信箱的檔案佈局(P 規格 §3.1)。
 *
 * 一則訊息一個檔案,三個檔名都用 question 的 id,一個問題的狀態就由那三個檔案的
 * 存在與否決定:沒有另外的狀態欄位要同步,也就沒有兩份真相對不上的可能。
 *
 * 專案內的信箱是主檔,`<userData>` 那份是副本。`git clean -fdx` 會刪掉被忽略的檔案,
 * 副本是為了那種時候還留得住紀錄(E 規格 §4.2)。讀取以專案內為準,專案內整個目錄
 * 不存在才用副本:逐檔混用兩邊會讓「哪一份是對的」變成要判斷的事。
 */
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { parsePeerMessage, type PeerMessage } from './message.js'

export const MAIL_DIR_NAME = 'mail'

export interface MailboxFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export const nodeMailboxFs: MailboxFs = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  readdir: (path) => readdir(path),
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
  exists: async (path) => {
    try {
      await access(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  },
}

export type QuestionStatus = 'pending' | 'answered' | 'cancelled'

export interface MailboxEntry {
  readonly question: PeerMessage
  readonly status: QuestionStatus
  /** answer 檔存在但解析不了。這種不等逾時,由 service 立刻取消(規格 §3.1)。 */
  readonly corruptAnswer: boolean
  readonly answer?: PeerMessage
  readonly cancel?: PeerMessage
}

export interface Mailbox {
  /** 原子寫主檔,成功後同步寫副本;副本失敗只記錯誤。主檔失敗往外拋。 */
  write(message: PeerMessage): Promise<void>
  read(questionId: string): Promise<MailboxEntry | null>
  list(): Promise<readonly MailboxEntry[]>
}

export interface MailboxDeps {
  /** `<project>/.yeschef/mail`。 */
  readonly dir: string
  /** `<userData>/yeschef-mail/<projectId>`。 */
  readonly mirrorDir: string
  readonly fs?: MailboxFs
  readonly logError: (error: Error) => void
}

export function fileNameFor(message: PeerMessage): string {
  const questionId = message.kind === 'question' ? message.id : (message.inReplyTo ?? message.id)
  return `${message.kind}-${questionId}.json`
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export function createMailbox(deps: MailboxDeps): Mailbox {
  const fs = deps.fs ?? nodeMailboxFs

  /** 讀一個檔並解析;不存在回 undefined,壞掉回 'corrupt'。 */
  const readOne = async (dir: string, name: string): Promise<PeerMessage | undefined | 'corrupt'> => {
    let raw: string
    try {
      raw = await fs.readFile(`${dir}/${name}`)
    } catch {
      return undefined
    }
    try {
      return parsePeerMessage(JSON.parse(raw)) ?? 'corrupt'
    } catch {
      return 'corrupt'
    }
  }

  /** 讀取用哪一個目錄:專案內整個目錄不存在才退到副本。 */
  const readDir = async (): Promise<string | null> => {
    if (await fs.exists(deps.dir)) return deps.dir
    if (await fs.exists(deps.mirrorDir)) return deps.mirrorDir
    return null
  }

  const writeAtomically = async (dir: string, name: string, data: string): Promise<void> => {
    await fs.mkdir(dir)
    const tmp = `${dir}/${name}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, `${dir}/${name}`)
  }

  const entryFor = async (dir: string, questionId: string): Promise<MailboxEntry | null> => {
    const question = await readOne(dir, `question-${questionId}.json`)
    if (question === undefined) return null
    if (question === 'corrupt') {
      deps.logError(new Error(`信箱裡 question-${questionId}.json 解析不了,已略過`))
      return null
    }
    const answerRaw = await readOne(dir, `answer-${questionId}.json`)
    const cancelRaw = await readOne(dir, `cancel-${questionId}.json`)
    // 終態檔壞掉:記錯誤並略過,那個問題視為未決,由逾時收掉(規格 §3.1)。
    if (answerRaw === 'corrupt') deps.logError(new Error(`信箱裡 answer-${questionId}.json 解析不了,已略過`))
    if (cancelRaw === 'corrupt') deps.logError(new Error(`信箱裡 cancel-${questionId}.json 解析不了,已略過`))
    const corruptAnswer = answerRaw === 'corrupt'
    const answer = corruptAnswer ? undefined : answerRaw
    const cancel = cancelRaw === 'corrupt' ? undefined : cancelRaw
    if (answer !== undefined && cancel !== undefined) {
      // 正常不會發生:寫 answer 前查 cancel、寫 cancel 前查 answer。掃到就當已取消。
      deps.logError(new Error(`問題 ${questionId} 同時有 answer 與 cancel,狀態當已取消`))
      return { question, status: 'cancelled', corruptAnswer, answer, cancel }
    }
    if (cancel !== undefined) return { question, status: 'cancelled', corruptAnswer, cancel }
    if (answer !== undefined) return { question, status: 'answered', corruptAnswer, answer }
    return { question, status: 'pending', corruptAnswer }
  }

  return {
    async write(message) {
      const name = fileNameFor(message)
      const data = JSON.stringify(message, null, 2)
      await writeAtomically(deps.dir, name, data)
      try {
        await writeAtomically(deps.mirrorDir, name, data)
      } catch (cause) {
        deps.logError(new Error(`信箱副本寫入失敗(${deps.mirrorDir}/${name}):${messageOf(cause)}`))
      }
    },

    async read(questionId) {
      const dir = await readDir()
      return dir === null ? null : await entryFor(dir, questionId)
    },

    async list() {
      const dir = await readDir()
      if (dir === null) return []
      let names: readonly string[]
      try {
        names = await fs.readdir(dir)
      } catch (cause) {
        deps.logError(new Error(`讀取信箱 ${dir} 失敗:${messageOf(cause)}`))
        return []
      }
      const questionIds = names
        .filter((n) => n.startsWith('question-') && n.endsWith('.json'))
        .map((n) => n.slice('question-'.length, -'.json'.length))
      const known = new Set(questionIds)
      for (const name of names) {
        const terminal = name.startsWith('answer-') || name.startsWith('cancel-')
        if (!terminal || !name.endsWith('.json')) continue
        const id = name.slice(name.indexOf('-') + 1, -'.json'.length)
        if (!known.has(id)) deps.logError(new Error(`信箱裡 ${name} 找不到對應的 question,已略過`))
      }
      const entries: MailboxEntry[] = []
      for (const id of questionIds) {
        const entry = await entryFor(dir, id)
        if (entry !== null) entries.push(entry)
      }
      return entries
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/peer-mailbox.test.ts`
Expected: PASS

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/peer/mailbox.ts tests/peer-mailbox.test.ts
git commit -m "feat: 同伴信箱的檔案佈局與三檔狀態判定"
```

---

### Task 3: 同伴登錄與 `to` 解析

**Files:**
- Create: `src/main/peer/registry.ts`
- Test: `tests/peer-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PeerRef`、`PEER_MSG`、`PeerError`、`PeerCandidate`。
- Produces:
  - `interface PeerEntry { conversationId: string; projectId: string; rootPath: string; provider: Provider; linkId(): string | undefined; isBusy(): boolean; deliver(text: string): void; recentText(): string }`
  - `interface PeerRegistry { register(entry: PeerEntry): void; unregister(conversationId: string): void; get(conversationId: string): PeerEntry | undefined; byLinkId(linkId: string): PeerEntry | undefined; peersOf(conversationId: string): readonly PeerEntry[]; resolve(conversationId: string, to: string | undefined): PeerEntry }`
  - `createPeerRegistry(): PeerRegistry`
  - `RECENT_TEXT_MAX = 40`

「活著」= 有登錄且 `linkId()` 有值(還沒開始的對話沒有 linkId,不能當同伴)。
`resolve` 失敗一律丟 `PeerError`,訊息帶候選清單。

- [ ] **Step 1: 寫失敗測試**

`tests/peer-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createPeerRegistry, type PeerEntry } from '../src/main/peer/registry.js'
import { PeerError } from '../src/main/peer/errors.js'

function entry(over: Partial<PeerEntry> & { conversationId: string }): PeerEntry {
  return {
    projectId: 'p-a',
    rootPath: '/p/alpha',
    provider: 'claude',
    linkId: () => `${over.conversationId}-link-0000`,
    isBusy: () => false,
    deliver: () => {},
    recentText: () => '',
    ...over,
  }
}

describe('register / unregister', () => {
  it('登錄之後查得到,移除之後查不到', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    expect(r.get('c1')?.conversationId).toBe('c1')
    r.unregister('c1')
    expect(r.get('c1')).toBeUndefined()
  })

  it('byLinkId 只找得到有 linkId 的', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    r.register(entry({ conversationId: 'c2', linkId: () => undefined }))
    expect(r.byLinkId('c1-link-0000')?.conversationId).toBe('c1')
    expect(r.byLinkId('c2-link-0000')).toBeUndefined()
  })
})

describe('peersOf', () => {
  it('只算同一個專案、有 linkId、且不是自己的', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    r.register(entry({ conversationId: 'c2' }))
    r.register(entry({ conversationId: 'c3', linkId: () => undefined }))
    r.register(entry({ conversationId: 'c4', projectId: 'p-b' }))
    expect(r.peersOf('c1').map((e) => e.conversationId)).toEqual(['c2'])
  })

  it('自己還沒登錄時回空陣列', () => {
    expect(createPeerRegistry().peersOf('nope')).toEqual([])
  })
})

describe('resolve', () => {
  const twoPeers = () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111', recentText: () => '在改 fold' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'bbbbbbbb-2222', provider: 'codex' }))
    return r
  }

  it('沒有同伴:錯誤說沒有別的同伴', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    expect(() => r.resolve('me', undefined)).toThrow(PeerError)
    expect(() => r.resolve('me', undefined)).toThrow('這個專案沒有別的同伴')
  })

  it('只有一個同伴:省略 to 就是它', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111' }))
    expect(r.resolve('me', undefined).conversationId).toBe('p1')
  })

  it('只有一個同伴但 to 對不上:錯誤並列出那一個', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111' }))
    expect(() => r.resolve('me', 'zzzz')).toThrow(/找不到同伴 zzzz.*aaaaaaaa/s)
  })

  it('兩個以上且沒給 to:錯誤要求指定,列出每一個的 id、provider 與最近訊息', () => {
    const r = twoPeers()
    expect(() => r.resolve('me', undefined)).toThrow(/to 要指定一個/)
    expect(() => r.resolve('me', undefined)).toThrow(/aaaaaaaa\(claude\):在改 fold/)
    expect(() => r.resolve('me', undefined)).toThrow(/bbbbbbbb\(codex\)/)
  })

  it('完整 linkId 對得上', () => {
    expect(twoPeers().resolve('me', 'bbbbbbbb-2222').conversationId).toBe('p2')
  })

  it('前 8 碼對得上', () => {
    expect(twoPeers().resolve('me', 'aaaaaaaa').conversationId).toBe('p1')
  })

  it('前 8 碼對到多個:錯誤要求給完整 id', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'same0000-1111' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'same0000-2222' }))
    expect(() => r.resolve('me', 'same0000')).toThrow(/對到多個同伴/)
  })

  it('完整比對優先於前綴:給完整 id 時不會因為別人前綴相同而歧義', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'same0000-1111' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'same0000-2222' }))
    expect(r.resolve('me', 'same0000-2222').conversationId).toBe('p2')
  })

  it('最近訊息超過 40 字時截斷', () => {
    const long = '一'.repeat(60)
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111', recentText: () => long }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'bbbbbbbb-2222' }))
    try {
      r.resolve('me', undefined)
      throw new Error('該丟錯')
    } catch (e) {
      expect((e as Error).message).toContain('一'.repeat(40))
      expect((e as Error).message).not.toContain('一'.repeat(41))
    }
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-registry.test.ts`
Expected: FAIL,`Cannot find module '../src/main/peer/registry.js'`

- [ ] **Step 3: 寫實作**

`src/main/peer/registry.ts`:

```ts
/**
 * 活著的同伴(P 規格 §5)。「活著」= 有登錄、而且已經有 linkId:
 * 還沒送過訊息的對話沒有 session,指不到它,也注入不進去。
 *
 * 登錄的內容由 `ipc-bridge` 提供:它是唯一知道每個對話的 core 在不在、忙不忙、
 * 怎麼把一則文字送進去的地方。這個檔只管「有誰」與「`to` 指的是誰」。
 */
import type { Provider } from '../../shared/projects.js'
import { PEER_MSG, PeerError, type PeerCandidate } from './errors.js'

export const RECENT_TEXT_MAX = 40

export interface PeerEntry {
  readonly conversationId: string
  readonly projectId: string
  readonly rootPath: string
  readonly provider: Provider
  /** 這個對話目前的 linkId(= sessionId);還沒開始就是 undefined。 */
  readonly linkId: () => string | undefined
  readonly isBusy: () => boolean
  /** 把一則文字送進這個對話,跟使用者打字同一條路。 */
  readonly deliver: (text: string) => void
  /** 最近一則使用者訊息,給候選清單用。 */
  readonly recentText: () => string
}

export interface PeerRegistry {
  register(entry: PeerEntry): void
  unregister(conversationId: string): void
  get(conversationId: string): PeerEntry | undefined
  byLinkId(linkId: string): PeerEntry | undefined
  /** 同一個專案裡除了自己以外還活著的。 */
  peersOf(conversationId: string): readonly PeerEntry[]
  /** 解析 `to`;失敗丟 `PeerError`,訊息一律帶候選清單。 */
  resolve(conversationId: string, to: string | undefined): PeerEntry
}

const candidateOf = (entry: PeerEntry): PeerCandidate => ({
  linkId: entry.linkId() ?? '',
  provider: entry.provider,
  recent: entry.recentText().slice(0, RECENT_TEXT_MAX),
})

export function createPeerRegistry(): PeerRegistry {
  const entries = new Map<string, PeerEntry>()

  const alive = (entry: PeerEntry): boolean => entry.linkId() !== undefined

  const peersOf = (conversationId: string): readonly PeerEntry[] => {
    const self = entries.get(conversationId)
    if (self === undefined) return []
    return [...entries.values()].filter(
      (e) => e.conversationId !== conversationId && e.projectId === self.projectId && alive(e),
    )
  }

  return {
    register(entry) { entries.set(entry.conversationId, entry) },
    unregister(conversationId) { entries.delete(conversationId) },
    get: (conversationId) => entries.get(conversationId),
    byLinkId: (linkId) => [...entries.values()].find((e) => alive(e) && e.linkId() === linkId),
    peersOf,

    resolve(conversationId, to) {
      const peers = peersOf(conversationId)
      const candidates = peers.map(candidateOf)
      if (peers.length === 0) throw new PeerError(PEER_MSG.noPeers)
      if (to === undefined) {
        const only = peers[0]
        if (peers.length === 1 && only !== undefined) return only
        throw new PeerError(PEER_MSG.toRequired(candidates))
      }
      // 完整比對優先:前綴相同的兩個同伴,給完整 id 時不該變成歧義。
      const exact = peers.find((e) => e.linkId() === to)
      if (exact !== undefined) return exact
      const prefixed = peers.filter((e) => (e.linkId() ?? '').startsWith(to))
      const first = prefixed[0]
      if (prefixed.length === 1 && first !== undefined) return first
      if (prefixed.length > 1) throw new PeerError(PEER_MSG.toAmbiguous(to, candidates))
      throw new PeerError(PEER_MSG.toUnknown(to, candidates))
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/peer-registry.test.ts`
Expected: PASS(13 tests)

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/peer/registry.ts tests/peer-registry.test.ts
git commit -m "feat: 同伴登錄與 to 的解析"
```

---

### Task 4: 同伴服務

**Files:**
- Create: `src/main/peer/service.ts`
- Test: `tests/peer-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `newQuestion`／`newAnswer`／`newCancel`／`PEER_MSG`／`PeerError`;Task 2 的 `Mailbox`、`MailboxEntry`;Task 3 的 `PeerRegistry`、`PeerEntry`。
- Produces:
  - `interface PeerTools { askPeer(question: string, to?: string): Promise<string>; answerPeer(id: string, text: string): Promise<string> }`
  - `interface PeerService { registry: PeerRegistry; forConversation(conversationId: string): PeerTools; notifyIdle(conversationId: string): void; conversationEnded(conversationId: string): void; cancelPendingOnStartup(projects: readonly { projectId: string; rootPath: string }[]): Promise<void>; dispose(): void }`
  - `createPeerService(deps: PeerServiceDeps): PeerService`
  - `interface PeerServiceDeps { registry: PeerRegistry; mailboxFor(projectId: string, rootPath: string): Mailbox; clock: MergerClock; newId(): string; logError(e: Error): void; scanIntervalMs?: number }`
  - `SCAN_INTERVAL_MS = 5_000`

行為(規格 §4、§5、§6.1、§6.3、§6.4、§7):

- `askPeer`:自己已有未決問題就錯;解析 `to`;對方正在等自己就是死鎖,錯;寫 question 檔;
  對方不忙就立刻注入,忙就排隊;等到 answer、cancel 或逾時。
- `answerPeer`:查狀態,四種錯誤各一;寫 answer 檔;行程內喚醒等待方。
- `notifyIdle(conversationId)`:那個對話的回合結束了,把排給它的提問送進去。
- `conversationEnded(conversationId)`:它問的問題寫「提問方已結束」;問它的問題寫「同伴已結束」。
- 掃描每 5 秒:過期的寫 cancel;answer 檔壞掉的立刻寫 cancel(原因「答案檔損毀」);
  行程內喚醒失敗時的後盾(掃到已答就交出答案)。
- `cancelPendingOnStartup(projects)`:呼叫端給要掃的專案(啟動當下 registry 還是空的,掃不到專案),
  把那些信箱裡的未決問題寫 cancel(原因「重啟時取消」)。

- [ ] **Step 1: 寫失敗測試**

`tests/peer-service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createPeerService, SCAN_INTERVAL_MS } from '../src/main/peer/service.js'
import { createPeerRegistry, type PeerEntry } from '../src/main/peer/registry.js'
import { createMailbox, type MailboxFs } from '../src/main/peer/mailbox.js'
import { PEER_MSG } from '../src/main/peer/errors.js'
import { QUESTION_TIMEOUT_MS } from '../src/main/peer/message.js'
import type { MergerClock } from '../src/main/agent-host.js'

/**
 * 手動推進的時鐘。與 `SYSTEM_CLOCK` 一樣是一次性計時器(setTimeout 語意):
 * 觸發後就從表裡消失,要再跑就得自己重排。service 的掃描迴圈正是這樣重排的。
 */
function fakeClock() {
  let now = 1_000_000
  const timers = new Map<number, { fn: () => void; at: number }>()
  let nextHandle = 1
  const clock: MergerClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = nextHandle
      nextHandle += 1
      timers.set(handle, { fn, at: now + ms })
      return handle
    },
    clearTimer: (handle) => { timers.delete(handle as number) },
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  /** 前進時間,跑掉到期的計時器,然後把 promise 佇列清乾淨。 */
  const advance = async (ms: number): Promise<void> => {
    now += ms
    for (const [handle, t] of [...timers]) {
      if (t.at > now) continue
      timers.delete(handle)
      t.fn()
      await tick()
    }
    await tick()
  }
  return { clock, advance, at: () => now }
}

function memFs() {
  const files = new Map<string, string>()
  const fs: MailboxFs = {
    async readFile(p) { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    async writeFile(p, d) { files.set(p, d) },
    async rename(from, to) { const v = files.get(from)!; files.delete(from); files.set(to, v) },
    async readdir(p) { const pre = `${p}/`; return [...files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)) },
    async mkdir() {},
    async exists(p) { return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)) },
  }
  return { fs, files }
}

function setup() {
  const { fs, files } = memFs()
  const { clock, advance } = fakeClock()
  const errors: string[] = []
  const delivered: Array<[string, string]> = []
  const registry = createPeerRegistry()
  let ids = 0
  const service = createPeerService({
    registry,
    mailboxFor: (projectId) => createMailbox({
      dir: `/p/${projectId}/.yeschef/mail`,
      mirrorDir: `/data/mail/${projectId}`,
      fs,
      logError: (e) => { errors.push(e.message) },
    }),
    clock,
    newId: () => `id-${(ids += 1)}`,
    logError: (e) => { errors.push(e.message) },
  })
  const busy = new Map<string, boolean>()
  const add = (conversationId: string, linkId: string): PeerEntry => {
    const entry: PeerEntry = {
      conversationId, projectId: 'alpha', rootPath: '/p/alpha', provider: 'claude',
      linkId: () => linkId,
      isBusy: () => busy.get(conversationId) ?? false,
      deliver: (text) => { delivered.push([conversationId, text]) },
      recentText: () => '',
    }
    registry.register(entry)
    return entry
  }
  return { service, registry, add, busy, delivered, errors, files, advance, clock }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('askPeer 的成功路徑', () => {
  it('寫 question、立刻注入對方、answerPeer 之後拿到答案', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('要用哪個欄位?')
    await flush()
    expect([...r.files.keys()].some((k) => k.endsWith('question-id-1.json'))).toBe(true)
    expect(r.delivered).toHaveLength(1)
    const [target, text] = r.delivered[0]!
    expect(target).toBe('B')
    expect(text).toContain('同伴(claude,aaaa1111)提問:要用哪個欄位?')
    expect(text).toContain('id 是 id-1')

    expect(await r.service.forConversation('B').answerPeer('id-1', '用 linkId')).toBe(PEER_MSG.answered)
    expect(await pending).toBe('用 linkId')
    expect([...r.files.keys()].some((k) => k.endsWith('answer-id-1.json'))).toBe(true)
  })

  it('對方回合進行中時排隊,回合結束才注入,而且只注入一次', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    void r.service.forConversation('A').askPeer('在忙嗎?')
    await flush()
    expect(r.delivered).toHaveLength(0)
    r.busy.set('B', false)
    r.service.notifyIdle('B')
    await flush()
    expect(r.delivered).toHaveLength(1)
    r.service.notifyIdle('B')
    await flush()
    expect(r.delivered).toHaveLength(1)
  })

  it('to 指定同伴時送給指定的那個', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.add('C', 'cccc3333')
    void r.service.forConversation('A').askPeer('問你', 'cccc3333')
    await flush()
    expect(r.delivered[0]?.[0]).toBe('C')
  })
})

describe('askPeer 的錯誤', () => {
  it('自己已有未決問題:第二次直接回錯誤,不寫檔', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    const before = r.files.size
    await expect(r.service.forConversation('A').askPeer('第二題')).rejects.toThrow(PEER_MSG.alreadyAsking('id-1'))
    expect(r.files.size).toBe(before)
  })

  it('死鎖:A 等 B 時 B 問 A,B 拿到錯誤,A 的問題不受影響', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const aPending = r.service.forConversation('A').askPeer('A 問 B')
    await flush()
    await expect(r.service.forConversation('B').askPeer('B 問 A')).rejects.toThrow(PEER_MSG.deadlock('id-1'))
    expect(await r.service.forConversation('B').answerPeer('id-1', '我先答')).toBe(PEER_MSG.answered)
    expect(await aPending).toBe('我先答')
  })

  it('沒有同伴:回錯誤', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    await expect(r.service.forConversation('A').askPeer('有人嗎')).rejects.toThrow(PEER_MSG.noPeers)
  })


describe('answerPeer 的錯誤', () => {
  it('四種錯誤各一', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const B = r.service.forConversation('B')
    await expect(B.answerPeer('nope', 'x')).rejects.toThrow(PEER_MSG.answerUnknown('nope'))

    void r.service.forConversation('A').askPeer('題目')
    await flush()
    // 不是問你的
    await expect(r.service.forConversation('A').answerPeer('id-1', 'x')).rejects.toThrow(PEER_MSG.answerNotYours('id-1'))
    await B.answerPeer('id-1', '答案')
    await expect(B.answerPeer('id-1', '再答一次')).rejects.toThrow(PEER_MSG.answerAlready('id-1'))

    void r.service.forConversation('A').askPeer('第二題')
    await flush()
    r.service.conversationEnded('A')
    await flush()
    await expect(B.answerPeer('id-2', '晚了')).rejects.toThrow(PEER_MSG.answerCancelled('id-2'))
  })
})

describe('逾時', () => {
  it('599 秒不取消,600 秒取消,原因正確', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('等你')
    await flush()
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })

    await r.advance(599_000)
    expect(settled).toBe(false)
    await r.advance(QUESTION_TIMEOUT_MS - 599_000 + SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect([...r.files.keys()].some((k) => k.endsWith('cancel-id-1.json'))).toBe(true)
  })

  it('答案檔壞掉:不等 10 分鐘,下一次掃描就取消', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('等你')
    await flush()
    r.files.set('/p/alpha/.yeschef/mail/answer-id-1.json', '不是 JSON')
    await r.advance(SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.answerCorrupt)
    expect([...r.files.keys()].some((k) => k.endsWith('cancel-id-1.json'))).toBe(true)
  })

  it('逾時從寫檔時算,不從注入時算', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    const pending = r.service.forConversation('A').askPeer('排隊中')
    await flush()
    await r.advance(QUESTION_TIMEOUT_MS + SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect(r.delivered).toHaveLength(0)
  })
})

describe('對話結束', () => {
  it('提問方結束:寫 cancel,原因是提問方已結束', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.service.conversationEnded('A')
    await expect(pending).rejects.toThrow(PEER_MSG.askerEnded)
  })

  it('回答方結束:立刻取消,不等 10 分鐘', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.service.conversationEnded('B')
    await expect(pending).rejects.toThrow(PEER_MSG.peerEnded)
  })
})

describe('重啟掃描', () => {
  it('未決全取消、已答已取消不動', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答完了')
    void r.service.forConversation('A').askPeer('第二題')
    await flush()

    await r.service.cancelPendingOnStartup([{ projectId: 'alpha', rootPath: '/p/alpha' }])
    const names = [...r.files.keys()].map((k) => k.split('/').pop())
    expect(names).toContain('answer-id-1.json')
    expect(names).toContain('cancel-id-2.json')
    expect(names).not.toContain('cancel-id-1.json')
    const cancel = JSON.parse([...r.files.entries()].find(([k]) => k.endsWith('cancel-id-2.json'))![1]) as { text: string }
    expect(cancel.text).toBe(PEER_MSG.restarted)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-service.test.ts`
Expected: FAIL,`Cannot find module '../src/main/peer/service.js'`

- [ ] **Step 3: 寫實作**

`src/main/peer/service.ts`:

```ts
/**
 * 同伴問答的行為(P 規格 §4、§5、§6、§7)。
 *
 * 阻塞的那一半在這裡:`askPeer` 回傳一個 promise,由四條路之一收掉:
 * 對方 `answer_peer`(行程內喚醒)、逾時掃描、對話結束、或掃描發現信箱裡已經有答案
 * (行程內喚醒失敗時的後盾)。每條路都寫檔,檔案是唯一的真相,行程內的 Map 只是加速。
 *
 * 注入不插隊:對方回合進行中就排著,`notifyIdle` 來了再送。逾時從寫檔時算,
 * 不從注入時算,問的那方感受到的是「我等了多久」。
 */
import type { MergerClock } from '../agent-host.js'
import { PEER_MSG, PeerError } from './errors.js'
import type { Mailbox, MailboxEntry } from './mailbox.js'
import { newAnswer, newCancel, newQuestion, type PeerMessage } from './message.js'
import type { PeerEntry, PeerRegistry } from './registry.js'

export const SCAN_INTERVAL_MS = 5_000

export interface PeerTools {
  /** 阻塞到收到答案;逾時、取消、對方結束都以 `PeerError` 結束。 */
  askPeer(question: string, to?: string): Promise<string>
  answerPeer(id: string, text: string): Promise<string>
}

export interface PeerServiceDeps {
  readonly registry: PeerRegistry
  readonly mailboxFor: (projectId: string, rootPath: string) => Mailbox
  readonly clock: MergerClock
  readonly newId: () => string
  readonly logError: (error: Error) => void
  readonly scanIntervalMs?: number
}

export interface PeerService {
  readonly registry: PeerRegistry
  forConversation(conversationId: string): PeerTools
  /** 某個對話的回合結束了:把排給它的提問送進去。 */
  notifyIdle(conversationId: string): void
  /** 某個對話結束了:它問的與問它的未決問題都收掉。 */
  conversationEnded(conversationId: string): void
  /** app 啟動時掃這些專案的信箱,未決全取消(規格 §7)。 */
  cancelPendingOnStartup(projects: readonly { projectId: string; rootPath: string }[]): Promise<void>
  dispose(): void
}

/** 一筆進行中的等待。檔案是真相,這裡只是為了讓 promise 收得掉。 */
interface Waiting {
  readonly questionId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  readonly projectId: string
  readonly rootPath: string
  readonly question: PeerMessage
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
  /** 還沒注入(對方回合進行中)。 */
  queued: boolean
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export function createPeerService(deps: PeerServiceDeps): PeerService {
  const waiting = new Map<string, Waiting>()
  const scanEvery = deps.scanIntervalMs ?? SCAN_INTERVAL_MS
  let disposed = false

  const mailboxOf = (entry: { projectId: string; rootPath: string }): Mailbox =>
    deps.mailboxFor(entry.projectId, entry.rootPath)

  const settle = (questionId: string, done: (w: Waiting) => void): void => {
    const w = waiting.get(questionId)
    if (w === undefined) return
    waiting.delete(questionId)
    done(w)
  }

  /** 寫 cancel 並讓等待方以那個原因結束。寫檔失敗只記錯,promise 照樣收掉。 */
  const cancelQuestion = async (w: Waiting, reason: string, actor: 'host' | 'user', swap = true): Promise<void> => {
    try {
      await mailboxOf(w).write(newCancel({ id: deps.newId(), question: w.question, reason, actor, now: deps.clock.now(), swap }))
    } catch (cause) {
      deps.logError(new Error(`寫 cancel 失敗(${w.questionId}):${messageOf(cause)}`))
    }
    settle(w.questionId, (x) => x.reject(new PeerError(reason)))
  }

  const inject = (w: Waiting): void => {
    const target = deps.registry.get(w.targetConversationId)
    if (target === undefined) {
      void cancelQuestion(w, PEER_MSG.peerEnded, 'host')
      return
    }
    if (target.isBusy()) {
      w.queued = true
      return
    }
    w.queued = false
    const from = w.question.from
    target.deliver(PEER_MSG.injection(from.provider, from.linkId, w.questionId, w.question.text))
  }

  /** 掃描:逾時、答案檔壞掉、行程內喚醒失敗的後盾。 */
  const scan = async (): Promise<void> => {
    const now = deps.clock.now()
    for (const w of [...waiting.values()]) {
      let entry: MailboxEntry | null = null
      try {
        entry = await mailboxOf(w).read(w.questionId)
      } catch (cause) {
        deps.logError(new Error(`掃描信箱失敗(${w.questionId}):${messageOf(cause)}`))
        continue
      }
      if (entry === null) continue
      if (entry.status === 'answered' && entry.answer !== undefined) {
        const text = entry.answer.text
        settle(w.questionId, (x) => x.resolve(text))
        continue
      }
      if (entry.status === 'cancelled' && entry.cancel !== undefined) {
        const reason = entry.cancel.text
        settle(w.questionId, (x) => x.reject(new PeerError(reason)))
        continue
      }
      // 答案檔壞掉:等下去也等不到答案,不等逾時(規格 §3.1)。
      if (entry.corruptAnswer) {
        await cancelQuestion(w, PEER_MSG.answerCorrupt, 'host')
        continue
      }
      const deadline = w.question.deadlineAt
      if (deadline !== null && now >= deadline) await cancelQuestion(w, PEER_MSG.timedOut, 'host')
    }
  }

  /**
   * 掃描迴圈。`MergerClock.setTimer` 是一次性的(setTimeout 語意),所以每輪掃完自己重排;
   * 掃描是 async,重排放在 finally,一次掃描丟出例外不會讓迴圈停掉。
   */
  let timer: unknown = null
  const arm = (): void => {
    timer = deps.clock.setTimer(() => {
      scan()
        .catch((cause: unknown) => { deps.logError(new Error(`掃描信箱失敗:${messageOf(cause)}`)) })
        .finally(() => { if (!disposed) arm() })
    }, scanEvery)
  }
  arm()

  const forConversation = (conversationId: string): PeerTools => ({
    async askPeer(question, to) {
      // dispose() 之後 MCP server 可能還在,工具還收得到呼叫。
      if (disposed) throw new PeerError(PEER_MSG.askerEnded)
      const self = deps.registry.get(conversationId)
      const linkId = self?.linkId()
      if (self === undefined || linkId === undefined) throw new PeerError(PEER_MSG.noPeers)
      const mine = [...waiting.values()].find((w) => w.askerConversationId === conversationId)
      if (mine !== undefined) throw new PeerError(PEER_MSG.alreadyAsking(mine.questionId))

      const target = deps.registry.resolve(conversationId, to)
      // 死鎖:對方正在等我回答(規格 §6.4)。
      const theirs = [...waiting.values()].find(
        (w) => w.askerConversationId === target.conversationId && w.targetConversationId === conversationId,
      )
      if (theirs !== undefined) throw new PeerError(PEER_MSG.deadlock(theirs.questionId))

      const targetLinkId = target.linkId()
      if (targetLinkId === undefined) throw new PeerError(PEER_MSG.peerEnded)
      const message = newQuestion({
        id: deps.newId(),
        from: { linkId, provider: self.provider },
        to: { linkId: targetLinkId, provider: target.provider },
        text: question,
        now: deps.clock.now(),
      })
      try {
        await deps.mailboxFor(self.projectId, self.rootPath).write(message)
      } catch (cause) {
        throw new PeerError(PEER_MSG.mailboxUnwritable(messageOf(cause)))
      }
      return await new Promise<string>((resolve, reject) => {
        const w: Waiting = {
          questionId: message.id,
          askerConversationId: conversationId,
          targetConversationId: target.conversationId,
          projectId: self.projectId,
          rootPath: self.rootPath,
          question: message,
          resolve,
          reject,
          queued: false,
        }
        waiting.set(message.id, w)
        inject(w)
      })
    },

    async answerPeer(id, text) {
      if (disposed) throw new PeerError(PEER_MSG.askerEnded)
      const self = deps.registry.get(conversationId)
      if (self === undefined) throw new PeerError(PEER_MSG.answerUnknown(id))
      const mailbox = deps.mailboxFor(self.projectId, self.rootPath)
      const entry = await mailbox.read(id)
      if (entry === null) throw new PeerError(PEER_MSG.answerUnknown(id))
      if (entry.status === 'answered') throw new PeerError(PEER_MSG.answerAlready(id))
      if (entry.status === 'cancelled') throw new PeerError(PEER_MSG.answerCancelled(id))
      if (entry.question.to.linkId !== self.linkId()) throw new PeerError(PEER_MSG.answerNotYours(id))
      await mailbox.write(newAnswer({ id: deps.newId(), question: entry.question, text, actor: 'session', now: deps.clock.now() }))
      // 行程內喚醒;失敗時掃描是後盾(規格 §6.3)。
      settle(id, (w) => w.resolve(text))
      return PEER_MSG.answered
    },
  })

  return {
    registry: deps.registry,
    forConversation,

    notifyIdle(conversationId) {
      for (const w of [...waiting.values()]) {
        if (w.targetConversationId === conversationId && w.queued) inject(w)
      }
    },

    conversationEnded(conversationId) {
      for (const w of [...waiting.values()]) {
        if (w.askerConversationId === conversationId) {
          // 提問方已結束:方向不換(規格 §6.5 的表)。
          void cancelQuestion(w, PEER_MSG.askerEnded, 'host', false)
        } else if (w.targetConversationId === conversationId) {
          void cancelQuestion(w, PEER_MSG.peerEnded, 'host')
        }
      }
    },

    // 啟動當下 registry 還是空的,要掃哪些專案由呼叫端給。
    async cancelPendingOnStartup(projects) {
      for (const p of projects) {
        const mailbox = deps.mailboxFor(p.projectId, p.rootPath)
        for (const item of await mailbox.list()) {
          if (item.status !== 'pending') continue
          await mailbox.write(newCancel({
            id: deps.newId(), question: item.question, reason: PEER_MSG.restarted, actor: 'host', now: deps.clock.now(),
          }))
        }
      }
    },

    dispose() {
      disposed = true
      deps.clock.clearTimer(timer)
      for (const w of [...waiting.values()]) {
        settle(w.questionId, (x) => x.reject(new PeerError(PEER_MSG.askerEnded)))
      }
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/peer-service.test.ts`
Expected: PASS

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/peer/service.ts tests/peer-service.test.ts
git commit -m "feat: 同伴問答的阻塞、注入、逾時與死鎖"
```

---

### Task 5: 把兩個工具掛上 MCP server

**Files:**
- Modify: `src/main/view-tools/policy.ts`
- Modify: `src/main/view-tools/server.ts`
- Test: `tests/view-tools/policy.test.ts`(改)、`tests/view-tools/server.test.ts`(改)

**Interfaces:**
- Consumes:Task 1 的 `ASK_PEER_TOOL`／`ANSWER_PEER_TOOL`／`PEER_MSG`／`PeerError`;Task 4 的 `PeerTools`。
- Produces:
  - `ViewTools.forProject(isActive: () => boolean, peer?: PeerTools): ProjectViewTools`
  - `PEER_TOOL_DESCRIPTIONS`(模組私有)

規則:

- `peer` 沒給就完全照舊,server 上只有八個工具。給了就多掛 `ask_peer`、`answer_peer`,
  順序固定接在八個之後。
- 這兩個工具不過 `isActive` 守衛:同伴問答與右窗格無關,背景對話也要能問能答。
- `ask_peer` 會阻塞到 10 分鐘,server 的 `timeout` 本來就是 11 分鐘,夠用,不改。
- 錯誤翻譯:`PeerError` 的 message 直接當工具結果文字,`isError` 為 true;其他例外照既有路徑
  走 `toErrorResult`。

- [ ] **Step 1: 改 policy 的失敗測試**

`tests/view-tools/policy.test.ts` 加一個 describe:

```ts
import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../src/shared/peer-tools.js'

describe('同伴問答的兩個工具', () => {
  it('都是 allow,不需要批准', () => {
    expect(viewToolPolicy(ASK_PEER_TOOL)).toBe('allow')
    expect(viewToolPolicy(ANSWER_PEER_TOOL)).toBe('allow')
  })

  it('名稱多打一段仍是 ask', () => {
    expect(viewToolPolicy(`${ASK_PEER_TOOL}_extra`)).toBe('ask')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/view-tools/policy.test.ts`
Expected: FAIL,`expected 'ask' to be 'allow'`

- [ ] **Step 3: 改 policy**

`src/main/view-tools/policy.ts`:把 `ALLOW_LIST` 改成兩份名單相加,其餘不動。

```ts
import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../shared/view-tools.js'
import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../shared/peer-tools.js'

const ALLOW_LIST: ReadonlySet<string> = new Set([
  ...VIEW_TOOL_NAMES.filter((name) => name !== 'view_eval').map((name) => fullToolName(name)),
  // 同伴問答不需要批准:一次呼叫只會讓另一個對話收到一段文字(P 規格 §4)。
  ASK_PEER_TOOL,
  ANSWER_PEER_TOOL,
])
```

檔頭那段註解裡的「七個」要跟著改成「七個右窗格工具加兩個同伴工具」,不要留下與程式碼不符的敘述。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/view-tools/policy.test.ts`
Expected: PASS

- [ ] **Step 5: 寫 server 的失敗測試**

`tests/view-tools/server.test.ts` 尾端加一個 describe。`build()` 是這個檔既有的
建置 helper,回傳 `ViewTools`;既有的「八個工具的名稱順序」與「八個工具都帶 alwaysLoad」
兩條測試不必改:預設的 `forProject(isActive)` 沒有 peer,server 上仍然只有八個。

```ts
import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../src/shared/peer-tools.js'
import { PeerError } from '../../src/main/peer/errors.js'
import type { PeerTools } from '../../src/main/peer/service.js'

const fakePeer = (over: Partial<PeerTools> = {}): PeerTools => ({
  askPeer: async () => '預設答案',
  answerPeer: async () => '已回答',
  ...over,
})

/** 從最近一次 createSdkMcpServer 的參數裡取一個工具的 handler。 */
const toolNamed = (name: string) => {
  const def = shared.serverOptions.tools?.find((t) => t.name === name)
  expect(def, name).toBeDefined()
  return def!
}

describe('同伴問答的兩個工具', () => {
  it('沒給 peer 就不掛,給了才多兩個,順序接在八個之後', async () => {
    const tools = await build()
    tools.forProject(() => true)
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
    tools.forProject(() => true, fakePeer())
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES, 'ask_peer', 'answer_peer'])
  })

  it('兩個工具都帶 alwaysLoad 與非空中文描述', async () => {
    const tools = await build()
    tools.forProject(() => true, fakePeer())
    for (const name of ['ask_peer', 'answer_peer']) {
      const def = toolNamed(name)
      expect(def._meta, name).toEqual({ 'anthropic/alwaysLoad': true })
      expect(def.description.length, name).toBeGreaterThan(0)
    }
  })

  it('背景對話也能用:isActive 是 false 時不回 browserBusy', async () => {
    const tools = await build()
    tools.forProject(() => false, fakePeer({ askPeer: async () => '背景也答得到' }))
    const result = await toolNamed('ask_peer').handler({ question: '在嗎' } as never, {})
    expect(result).toEqual({ content: [{ type: 'text', text: '背景也答得到' }] })
  })

  it('ask_peer 把 to 傳下去', async () => {
    const tools = await build()
    const seen: Array<[string, string | undefined]> = []
    tools.forProject(() => true, fakePeer({
      askPeer: async (question, to) => { seen.push([question, to]); return '好' },
    }))
    await toolNamed('ask_peer').handler({ question: '問題', to: 'bbbb' } as never, {})
    await toolNamed('ask_peer').handler({ question: '沒指定' } as never, {})
    expect(seen).toEqual([['問題', 'bbbb'], ['沒指定', undefined]])
  })

  it('answer_peer 回傳服務給的那句話', async () => {
    const tools = await build()
    tools.forProject(() => true, fakePeer({ answerPeer: async (id) => `已回答 ${id}` }))
    const result = await toolNamed('answer_peer').handler({ id: 'q1', text: '答案' } as never, {})
    expect(result).toEqual({ content: [{ type: 'text', text: '已回答 q1' }] })
  })

  it('PeerError 變成 isError 的工具結果,訊息原樣送給模型', async () => {
    const tools = await build()
    tools.forProject(() => true, fakePeer({
      askPeer: async () => { throw new PeerError('這個專案沒有別的同伴') },
    }))
    const result = await toolNamed('ask_peer').handler({ question: '有人嗎' } as never, {})
    expect(result).toEqual({ content: [{ type: 'text', text: '這個專案沒有別的同伴' }], isError: true })
  })

  it('工具名稱的完整形式與 shared 的常數一致', () => {
    expect(ASK_PEER_TOOL).toBe('mcp__yeschef__ask_peer')
    expect(ANSWER_PEER_TOOL).toBe('mcp__yeschef__answer_peer')
  })
})
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/view-tools/server.test.ts`
Expected: FAIL,`forProject` 只吃一個參數,`ask_peer` 找不到

- [ ] **Step 7: 改 server**

`src/main/view-tools/server.ts` 四處改動。

其一,`import`:

```ts
import { PeerError } from '../peer/errors.js'
import type { PeerTools } from '../peer/service.js'
```

其二,描述常數,放在 `TOOL_DESCRIPTIONS` 後面:

```ts
/** 同伴問答的兩句話(P 規格 §4)。字串是模型可見文案。 */
const PEER_TOOL_DESCRIPTIONS = {
  ask_peer: '問同一個專案裡的另一個對話一個問題,並等它回答。對方最多 10 分鐘沒回就會回錯誤。',
  answer_peer: '回答同伴問你的問題。答不出來也要回答「答不出來」加原因,不要不回。',
} as const
```

其三,建工具的函式。`runTool` 會擋背景專案,同伴工具不能走它,自己寫一個薄殼:

```ts
/**
 * 同伴工具的外殼。與 `runTool` 的差別有兩個:不過前景守衛(P 規格 §4:背景對話也要能問能答),
 * 也不進 inflight(等待由 service 自己的逾時收掉,不該被右窗格的 abortPending 打斷)。
 */
async function runPeerTool(
  logError: (error: Error) => void,
  action: () => Promise<string>
): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await action() }] }
  } catch (error) {
    if (error instanceof PeerError) return errorResult(error.message)
    const wrapped = error instanceof Error ? error : new Error(String(error))
    logError(wrapped)
    return errorResult(MSG.internal(wrapped.message))
  }
}

function createPeerTools(peer: PeerTools, logError: (error: Error) => void) {
  const always = { alwaysLoad: true }
  return [
    tool('ask_peer', PEER_TOOL_DESCRIPTIONS.ask_peer, {
      question: z.string(), to: z.string().optional(),
    }, (args) => runPeerTool(logError, () => peer.askPeer(args.question, args.to)), always),
    tool('answer_peer', PEER_TOOL_DESCRIPTIONS.answer_peer, {
      id: z.string(), text: z.string(),
    }, (args) => runPeerTool(logError, () => peer.answerPeer(args.id, args.text)), always),
  ]
}
```

其四,`forProject` 多一個選用參數,工具清單相加:

```ts
    const forProject = (isActive: () => boolean, peer?: PeerTools): ProjectViewTools => {
      const inflight = new Set<AbortController>()
      projects.add(inflight)
      let disposed = false
      const runtime: ToolRuntime = {
        controller, inflight, isActive, isDisposed: () => disposed, logError: deps.logError,
      }
      const server = createSdkMcpServer({
        name: VIEW_TOOL_SERVER_NAME,
        version: SERVER_VERSION,
        tools: [
          ...createTools(runtime),
          ...(peer === undefined ? [] : createPeerTools(peer, deps.logError)),
        ],
        timeout: TOOL_CALL_TIMEOUT_MS,
      })
```

介面宣告也要跟著改:

```ts
  /** 替一個專案建一份 MCP server；isActive 回 false 時八個瀏覽器工具都直接回 MSG.browserBusy。
   *  給了 peer 就多掛 ask_peer 與 answer_peer，那兩個不受前景守衛限制。 */
  forProject(isActive: () => boolean, peer?: PeerTools): ProjectViewTools
```

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run tests/view-tools/`
Expected: 全部 PASS

- [ ] **Step 9: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 10: Commit**

```bash
git add src/main/view-tools/policy.ts src/main/view-tools/server.ts tests/view-tools/policy.test.ts tests/view-tools/server.test.ts
git commit -m "feat: ask_peer 與 answer_peer 掛上程序內 MCP server"
```

---

### Task 6: 主行程接線

**Files:**
- Modify: `src/main/ipc-bridge.ts`
- Modify: `src/main/index.ts`
- Test: `tests/ipc-bridge.test.ts`(加)

**Interfaces:**
- Consumes:Task 3 的 `PeerEntry`、Task 4 的 `PeerService`、Task 5 的 `forProject(isActive, peer?)`。
- Produces:
  - `IpcBridgeDeps.peer?: PeerService`
  - `ProjectRuntime` 不變(`sessionOptions` 由 `runtimeFor` 產生,peer 工具在 `index.ts` 掛進去)

接線的四件事:

1. `createSlot` 建好 core 之後登錄一個 `PeerEntry`;`linkId` 從專案狀態即時讀(每次呼叫都讀,
   因為 resume 之後會換),`isBusy` 就是 `core.isBusy()`,`deliver` 就是 `core.userInput(text)`。
2. `onBusyChange`:忙 → 閒時通知 `notifyIdle`,排隊中的提問這時才注入。
3. 對話收掉(`disposeSlot`)與開新對話(`intentStartNew`)都算「那一場結束」:先 `conversationEnded`
   再 `unregister`,順序不能反,反了就找不到要取消哪些。
4. `recentText`:記住 renderer 送進來的最後一則使用者訊息。注入進去的同伴提問不走這條路
   (它直接呼叫 `core.userInput`),所以候選清單顯示的是人真正打過的字。

- [ ] **Step 1: 寫失敗測試**

`tests/ipc-bridge.test.ts` 尾端加一個 describe。這個檔既有的 helper 怎麼建 bridge、
怎麼送 IPC,照現有寫法沿用;下面只列新增的斷言與需要的假物件。

```ts
import type { PeerEntry, PeerRegistry } from '../src/main/peer/registry.js'
import type { PeerService, PeerTools } from '../src/main/peer/service.js'

/** 只記下被呼叫了什麼,不做事。 */
function fakePeerService() {
  const entries = new Map<string, PeerEntry>()
  const calls: string[] = []
  const registry = {
    register: (e: PeerEntry) => { entries.set(e.conversationId, e); calls.push(`register:${e.conversationId}`) },
    unregister: (id: string) => { entries.delete(id); calls.push(`unregister:${id}`) },
    get: (id: string) => entries.get(id),
    byLinkId: () => undefined,
    peersOf: () => [],
    resolve: () => { throw new Error('未使用') },
  } as unknown as PeerRegistry
  const service: PeerService = {
    registry,
    forConversation: (): PeerTools => ({ askPeer: async () => '', answerPeer: async () => '' }),
    notifyIdle: (id) => { calls.push(`idle:${id}`) },
    conversationEnded: (id) => { calls.push(`ended:${id}`) },
    cancelPendingOnStartup: async () => {},
    dispose: () => {},
  }
  return { service, entries, calls, register: registry.register.bind(registry) }
}

describe('同伴登錄', () => {
  it('每個對話建 core 時登錄一次,linkId、provider、rootPath 都對', async () => {
    const peer = fakePeerService()
    // 專案 p1 有一個 claude 對話 c1,狀態檔裡它的 thread 最後一場 link 是 'sess-1'。
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    const entry = peer.entries.get('c1')
    expect(entry).toBeDefined()
    expect(entry?.provider).toBe('claude')
    expect(entry?.rootPath).toBe('/p/one')
    expect(entry?.linkId()).toBe('sess-1')
  })

  it('linkId 每次都重讀:resume 換了 session 之後回新的那個', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.appendSession('c1', 'sess-2')
    expect(peer.entries.get('c1')?.linkId()).toBe('sess-2')
  })

  it('deliver 就是把文字送進那個對話', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    peer.entries.get('c1')?.deliver('同伴提問')
    expect(h.coreFor('c1').userInput).toHaveBeenCalledWith('同伴提問')
  })

  it('recentText 是使用者最後打的那句,注入的提問不算', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.send(IPC.userInput, '我打的字')
    peer.entries.get('c1')?.deliver('同伴(claude,aaaa)提問:別的字')
    expect(peer.entries.get('c1')?.recentText()).toBe('我打的字')
  })

  it('回合結束時通知 notifyIdle,開始忙不通知', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.coreFor('c1').emitBusy(true)
    expect(peer.calls).not.toContain('idle:c1')
    h.coreFor('c1').emitBusy(false)
    expect(peer.calls).toContain('idle:c1')
  })

  it('對話關掉時先 conversationEnded 再 unregister', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.closeTab('c1')
    expect(peer.calls.filter((c) => c.endsWith(':c1'))).toEqual(['register:c1', 'ended:c1', 'unregister:c1'])
  })

  it('開新對話也算那一場結束,但不取消登錄', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.send(IPC.intentStartNew, undefined)
    expect(peer.calls).toContain('ended:c1')
    expect(peer.calls).not.toContain('unregister:c1')
  })

  it('沒給 peer 時一切照舊,不會丟例外', async () => {
    const h = await harnessWithPeer(undefined)
    h.focus('c1')
    h.send(IPC.userInput, '照舊')
    expect(h.coreFor('c1').userInput).toHaveBeenCalledWith('照舊')
  })
})
```

`harnessWithPeer(service)` 照這個檔既有的 bridge 建置寫法包一層:多傳 `peer: service`,
並提供 `appendSession`(把一個 `SessionLink` 加進狀態檔那個 thread)、`closeTab`、
`coreFor`(取到那個對話的假 core,含 `emitBusy` 觸發 `onBusyChange`)三個操作。
既有 helper 已有 `focus`、`send` 與假 core 工廠,沿用,不要另外開一套。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL,`peer` 不是 `IpcBridgeDeps` 的欄位

- [ ] **Step 3: 改 ipc-bridge**

`src/main/ipc-bridge.ts`:

其一,`import` 與 deps:

```ts
import type { PeerService } from './peer/service.js'
```

```ts
  /** 同伴問答(P 規格 §4)。沒給就沒有同伴功能,其餘行為完全不變。 */
  readonly peer?: PeerService
```

其二,模組內多一個 Map,記使用者最後打的字:

```ts
  /** 鍵是 conversationId。只記 renderer 送來的使用者訊息,注入的同伴提問不進來。 */
  const lastUserText = new Map<string, string>()
```

`onUserInput` 的 `withActive` 回呼改成兩件事:

```ts
      withActive(IPC.userInput, (slot, conversationId) => {
        lastUserText.set(conversationId, text)
        slot.core.userInput(text)
      })
```

其三,`createSlot` 裡 `common` 的 `onBusyChange` 改成具名函式,並在兩個分支各自登錄:

```ts
    const common = {
      sink,
      logError: deps.logError,
      onHeldChange: pushProjects,
      onBusyChange: (busy: boolean) => {
        pushProjects()
        // 回合結束才輪到排隊中的同伴提問(P 規格 §6.1)。
        if (!busy) deps.peer?.notifyIdle(conversationId)
      },
      approvalTimeoutMs: deps.approvalTimeoutMs,
      createRegistry: deps.createRegistry,
    }

    const provider: Provider = (tab?.provider ?? 'claude')

    /**
     * 登錄成同伴。四個取值都是即時的:linkId 與 rootPath 在 resume 或搬目錄之後會變,
     * 抓一次存起來就會過期。
     */
    const registerPeer = (core: Conversation): void => {
      deps.peer?.registry.register({
        conversationId,
        projectId,
        rootPath,
        provider,
        linkId: () => {
          const now = findProject(deps.projects.state(), projectId)
          return now === undefined ? undefined : currentThread(now, conversationId)?.sessions.at(-1)?.linkId
        },
        isBusy: () => core.isBusy(),
        deliver: (text: string) => { core.userInput(text) },
        recentText: () => lastUserText.get(conversationId) ?? '',
      })
    }
```

`tab` 目前宣告在 codex 分支上方,`provider` 與 `registerPeer` 接在它後面;兩個分支
`return` 之前各加一行 `registerPeer(core)`。

其四,收尾與開新對話:

`disposeSlot` 開頭(`slots.delete` 之前):

```ts
  const disposeSlot = (conversationId: string, slot: Slot): void => {
    // 順序不能反:先讓 service 依登錄資料取消未決問題,再把登錄拿掉。
    deps.peer?.conversationEnded(conversationId)
    deps.peer?.registry.unregister(conversationId)
    lastUserText.delete(conversationId)
    slots.delete(conversationId)
```

`IPC.intentStartNew` 的處理裡,呼叫 `slot.core.startNew()` 之前:

```ts
      // 開新對話等於這一場結束:未決的同伴問答收掉,但這個分頁還在,登錄留著。
      deps.peer?.conversationEnded(conversationId)
```

`dispose()` 收尾時把還在的登錄清乾淨:走既有的 `disposeSlot` 迴圈就會做到,不另外寫。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: 接上 index**

`src/main/index.ts` 四處改動,這個檔不在覆蓋率統計內,沒有單元測試,改完靠 typecheck 與實機驗收。

其一,`import`:

```ts
import { createMailbox, nodeMailboxFs } from './peer/mailbox.js'
import { createPeerRegistry } from './peer/registry.js'
import { createPeerService } from './peer/service.js'
```

其二,建服務(放在 `runtimeFor` 之前,`service` 與 `logError` 都已存在):

```ts
  // P 規格 §3.1:信箱在專案裡,副本在 userData。
  const mailDir = join(app.getPath('userData'), 'yeschef-mail')
  const peer = createPeerService({
    registry: createPeerRegistry(),
    mailboxFor: (projectId, rootPath) => createMailbox({
      dir: join(rootPath, '.yeschef', 'mail'),
      mirrorDir: join(mailDir, projectId),
      fs: nodeMailboxFs,
      logError,
    }),
    clock: SYSTEM_CLOCK,
    newId: randomUUID,
    logError,
  })
  // 規格 §7:上一次沒收完的問題,啟動時一律取消。
  peer.cancelPendingOnStartup(service.state().projects.map((p) => ({ projectId: p.id, rootPath: p.rootPath })))
    .catch((cause: unknown) => { logError(toError(cause)) })
```

`SYSTEM_CLOCK` 已由 `agent-host.js` 匯入(既有的 `clock: SYSTEM_CLOCK` 就是它),
`randomUUID` 也已在檔頭匯入,不必重複。

其三,`runtimeFor` 把該對話的同伴工具掛進 MCP server:

```ts
  const runtimeFor = (_projectId: string, rootPath: string, isActive: () => boolean, conversationId: string): ProjectRuntime => {
    const shared = startup.viewTools
    const own = shared?.forProject(isActive, peer.forConversation(conversationId))
```

參數名 `_conversationId` 要改成 `conversationId`(現在用得到了)。

其四,`createIpcBridge` 多傳 `peer`,並在既有的收尾流程裡加 `peer.dispose()`
(放在 `bridge.dispose()` 之後、`startup.viewTools?.dispose()` 附近,與其他 dispose 同一段):

```ts
  const bridge = createIpcBridge({
    webContents: conversationView.webContents,
    projects: service,
    sessions,
    runtimeFor,
    peer,
    logError,
    homeDir: homedir(),
    terminalPort: term?.port,
  })
```

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc-bridge.ts src/main/index.ts tests/ipc-bridge.test.ts
git commit -m "feat: 主行程接上同伴問答,每個對話登錄成同伴"
```

---

## 驗收

單元測試以外,這一階段要能用兩個真的對話跑完下面六項。第二階段的畫面還沒做,
所以驗收看的是「同伴那邊收到什麼、提問方拿到什麼」,不是畫面長什麼樣。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 同一個專案開兩個 Claude 對話,在 A 請它用 `ask_peer` 問 B 一個問題 | B 的畫面出現一段「同伴(claude,前 8 碼)提問:…」的使用者訊息,A 停在工具呼叫中 |
| 2 | 讓 B 用 `answer_peer` 回答 | A 的工具結果就是 B 的答案,A 接著往下做 |
| 3 | B 正在跑一個長回合時,在 A 問問題 | 提問不插隊;B 那一輪結束後才出現提問 |
| 4 | 開三個對話,在 A 不給 `to` 問 | 回錯誤,訊息列出兩個候選的前 8 碼與最近一句話 |
| 5 | A 問 B 之後,在 B 問 A | B 拿到「對方正在等你回答 #…」,A 的問題不受影響 |
| 6 | A 問 B 之後直接關掉 app 再開 | 專案的 `.yeschef/mail/` 裡多一個 `cancel-<id>.json`,text 是「重啟時取消」 |

檢查信箱檔案:

```bash
ls -1 <專案>/.yeschef/mail/
cat <專案>/.yeschef/mail/cancel-*.json
```

## 自我檢查

寫完之後對照規格看一遍,三件事:

**規格涵蓋**:P 規格 §3.1(信箱與壞檔)在 Task 2;§3.2(訊息形狀)在 Task 1;
§4(兩個工具)在 Task 1 的常數、Task 4 的行為、Task 5 的掛載;§5(`to` 解析)在 Task 3;
§6.1(注入與排隊)在 Task 4 與 Task 6;§6.3(逾時與行程內喚醒)在 Task 4;
§6.4(死鎖)在 Task 4;§7(重啟取消)在 Task 4 與 Task 6。
§6.2(畫面)與 §6.5(人的介入)明列為第二階段,§8 的 codex 接線是第三階段,本計畫不做。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼或可以直接跑的指令,沒有「依此類推」。
Task 6 的測試 helper 明講沿用既有的 bridge 建置寫法,不是新開一套。

**型別一致**:`PeerMessage`、`PeerRef`、`PeerEntry`、`PeerRegistry`、`Mailbox`、
`MailboxEntry`、`PeerService`、`PeerTools` 在後面的 Task 用到時,名稱與參數順序都與
定義它的那個 Task 相同;`forProject(isActive, peer?)` 的第二個參數型別是 `PeerTools`,
Task 5 與 Task 6 兩邊一致;`cancelPendingOnStartup` 吃一個 `{ projectId, rootPath }` 陣列,
Task 4 的測試與 Task 6 的呼叫都照這個形狀。
