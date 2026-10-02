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
  const mailbox = createMailbox({ dir: DIR, ignoreDir: '/p/alpha/.yeschef', mirrorDir: MIRROR, fs: m.fs, logError: (e) => { errors.push(e.message) } })
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
  it('第一次寫入建立忽略整個 .yeschef 的 .gitignore', async () => {
    const r = setup()
    await r.mailbox.write(q('q1'))
    expect(r.files.get('/p/alpha/.yeschef/.gitignore')).toBe('*\n')
  })

  it('既有 .gitignore 不覆寫', async () => {
    const r = setup({ '/p/alpha/.yeschef/.gitignore': 'mail/\n' })
    await r.mailbox.write(q('q1'))
    expect(r.files.get('/p/alpha/.yeschef/.gitignore')).toBe('mail/\n')
  })

  it('.gitignore 寫失敗只記錯誤,信箱仍可寫入', async () => {
    const r = setup()
    r.failWriteUnder('/p/alpha/.yeschef/.gitignore')
    await r.mailbox.write(q('q1'))
    expect(r.files.has(`${DIR}/question-q1.json`)).toBe(true)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('.gitignore')
  })

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

describe('restoreFromMirror', () => {
  it('兩邊都在時不混用或覆寫', async () => {
    const r = setup({ [`${DIR}/question-q1.json`]: '主檔', [`${MIRROR}/question-q1.json`]: '副本' })
    await r.mailbox.restoreFromMirror()
    expect(r.files.get(`${DIR}/question-q1.json`)).toBe('主檔')
    expect(r.ops).toEqual([])
  })

  it('副本不存在時不建目錄', async () => {
    const r = setup()
    await r.mailbox.restoreFromMirror()
    expect(r.ops).toEqual([])
  })

  it('複製失敗只記錯誤', async () => {
    const r = setup({ [`${MIRROR}/question-q1.json`]: JSON.stringify(q('q1')) })
    r.failWriteUnder(DIR)
    await expect(r.mailbox.restoreFromMirror()).resolves.toBeUndefined()
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('還原失敗')
  })
})
