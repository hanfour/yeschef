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
import { PEER_MSG } from './errors.js'

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
  restoreFromMirror(): Promise<void>
}

export interface MailboxDeps {
  /** `<project>/.yeschef/mail`。 */
  readonly dir: string
  /** `<project>/.yeschef`,以自己的 .gitignore 忽略信箱。 */
  readonly ignoreDir: string
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

  const ensureProjectDir = async (): Promise<void> => {
    await fs.mkdir(deps.dir)
    try {
      const ignorePath = `${deps.ignoreDir}/.gitignore`
      if (!await fs.exists(ignorePath)) {
        await fs.mkdir(deps.ignoreDir)
        await fs.writeFile(ignorePath, '*\n')
      }
    } catch (cause) {
      deps.logError(new Error(`信箱 .gitignore 寫入失敗: ${messageOf(cause)}`))
    }
  }

  const writeAtomically = async (dir: string, name: string, data: string): Promise<void> => {
    if (dir === deps.dir) await ensureProjectDir()
    else await fs.mkdir(dir)
    const tmp = `${dir}/${name}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, `${dir}/${name}`)
  }

  const entryFor = async (dir: string, questionId: string): Promise<MailboxEntry | null> => {
    const question = await readOne(dir, `question-${questionId}.json`)
    if (question === undefined) return null
    if (question === 'corrupt') {
      deps.logError(new Error(PEER_MSG.mailboxCorruptFile(`question-${questionId}.json`)))
      return null
    }
    const answerRaw = await readOne(dir, `answer-${questionId}.json`)
    const cancelRaw = await readOne(dir, `cancel-${questionId}.json`)
    // 終態檔壞掉:記錯誤並略過;損毀 answer 由 service 立刻取消,損毀 cancel 等逾時收掉。
    if (answerRaw === 'corrupt') deps.logError(new Error(PEER_MSG.mailboxCorruptFile(`answer-${questionId}.json`)))
    if (cancelRaw === 'corrupt') deps.logError(new Error(PEER_MSG.mailboxCorruptFile(`cancel-${questionId}.json`)))
    const corruptAnswer = answerRaw === 'corrupt'
    const answer = corruptAnswer ? undefined : answerRaw
    const cancel = cancelRaw === 'corrupt' ? undefined : cancelRaw
    if (answer !== undefined && cancel !== undefined) {
      // 正常不會發生:寫 answer 前查 cancel、寫 cancel 前查 answer。掃到就當已取消。
      deps.logError(new Error(PEER_MSG.mailboxConflictingTerminal(questionId)))
      return { question, status: 'cancelled', corruptAnswer, answer, cancel }
    }
    if (cancel !== undefined) return { question, status: 'cancelled', corruptAnswer, cancel }
    if (answer !== undefined) return { question, status: 'answered', corruptAnswer, answer }
    return { question, status: 'pending', corruptAnswer }
  }

  return {
    async restoreFromMirror() {
      try {
        if (await fs.exists(deps.dir) || !await fs.exists(deps.mirrorDir)) return
        const names = await fs.readdir(deps.mirrorDir)
        await ensureProjectDir()
        for (const name of names) {
          await fs.writeFile(`${deps.dir}/${name}`, await fs.readFile(`${deps.mirrorDir}/${name}`))
        }
      } catch (cause) {
        deps.logError(new Error(`信箱副本還原失敗: ${messageOf(cause)}`))
      }
    },

    async write(message) {
      const name = fileNameFor(message)
      const data = JSON.stringify(message, null, 2)
      await writeAtomically(deps.dir, name, data)
      try {
        await writeAtomically(deps.mirrorDir, name, data)
      } catch (cause) {
        deps.logError(new Error(PEER_MSG.mailboxMirrorWriteFailed(`${deps.mirrorDir}/${name}`, messageOf(cause))))
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
        deps.logError(new Error(PEER_MSG.mailboxReadFailed(dir, messageOf(cause))))
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
        if (!known.has(id)) deps.logError(new Error(PEER_MSG.mailboxOrphanTerminal(name)))
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
