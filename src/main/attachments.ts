import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile, rm, lstat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Attachment, PromptAttachment } from '../shared/conversation-tools.js'
const MIME: Record<string, PromptAttachment['mime']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const TEXT = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.ts', '.tsx', '.js', '.py', '.log'])
const DOCUMENT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.rtf'])
interface Stored { owner: string; meta: Attachment; value: PromptAttachment; sent: boolean }
export function createAttachments(dir: string, pick: () => Promise<string[]>) {
  const stored = new Map<string, Stored>()
  const pending = new Set<string>()
  return {
    async pick(owner: string): Promise<Attachment[]> {
      if (pending.has(owner)) throw Error('附件選擇正在進行')
      pending.add(owner)
      const created: string[] = []
      try {
        const paths = await pick()
        const existing = [...stored.values()].filter(a => a.owner === owner && !a.sent)
        if (existing.length + paths.length > 8) throw Error('每則訊息最多 8 個附件')
        let total = existing.reduce((n, a) => n + a.meta.size, 0)
        let inlineBytes = existing.filter(a => a.value.kind === 'text').reduce((n, a) => n + a.meta.size, 0)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const result: Attachment[] = []
        for (const path of paths) {
          const info = await lstat(path)
          if (!info.isFile() || info.isSymbolicLink()) throw Error('只能附加一般檔案')
          const ext = extname(path).toLowerCase(), mime = MIME[ext]
          if (!mime && !TEXT.has(ext) && !DOCUMENT.has(ext)) throw Error(`不支援的附件格式：${ext || '無副檔名'}`)
          const limit = mime ? 5 * 1024 * 1024 : 10 * 1024 * 1024
          if (info.size > limit) throw Error(`${basename(path)} 過大：圖片最多 5 MiB，文件最多 10 MiB`)
          total += info.size; if (total > 20 * 1024 * 1024) throw Error('附件合計最多 20 MiB')
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          let bytes: Buffer
          try {
            const checked = await handle.stat()
            if (!checked.isFile() || checked.ino !== info.ino || checked.size !== info.size) throw Error('檔案在附加時已改變，請重試')
            const buffer = Buffer.alloc(info.size + 1)
            let totalRead = 0
            while (totalRead < buffer.length) { const part = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead); if (!part.bytesRead) break; totalRead += part.bytesRead }
            bytes = buffer.subarray(0, totalRead)
          } finally { await handle.close() }
          if (bytes.length !== info.size) throw Error('檔案在附加時已改變，請重試')
          const id = randomUUID(), copy = join(dir, `${id}${ext}`)
          const name = basename(path)
          const kind = mime ? 'image' : TEXT.has(ext) && inlineBytes + bytes.length <= 200000 ? 'text' : 'file'
          if (kind === 'text') inlineBytes += bytes.length
          if (kind === 'text' && bytes.includes(0)) throw Error(`${name} 不是可讀取的文字文件`)
          // Validate magic bytes before sending an image as a native multimodal block.
          if (mime && !((mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) || (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || (mime === 'image/gif' && /^GIF8[79]a/.test(bytes.subarray(0,6).toString())) || (mime === 'image/webp' && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'))) throw Error(`${name} 的圖片內容與副檔名不符`)
          const text = kind === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined
          await writeFile(copy, bytes, { flag: 'wx', mode: 0o400 })
          const data = mime ? bytes.toString('base64') : undefined
          const meta: Attachment = { id, name, size: bytes.length, kind, ...(data ? { thumbnail: `data:${mime};base64,${data}` } : {}) }
          stored.set(id, { owner, meta, sent: false, value: { name, path: copy, kind, mime: mime ?? 'application/octet-stream', ...(data ? { data } : {}), ...(text === undefined ? {} : { text }) } })
          created.push(id); result.push(meta)
        }
        return result
      } catch (error) {
        for (const id of created) { const a = stored.get(id)!; stored.delete(id); await rm(a.value.path, { force: true }) }
        throw error
      } finally { pending.delete(owner) }
    },
    prepare(owner: string, ids: readonly string[]): PromptAttachment[] {
      if (ids.length > 8 || new Set(ids).size !== ids.length) throw Error('附件數量或識別碼不正確')
      return ids.map(id => { const a = stored.get(id); if (!a || a.owner !== owner || a.sent) throw Error('附件已失效或不屬於此對話，請重新附加'); return a.value })
    },
    sent(ids: readonly string[]) { for (const id of ids) { const a = stored.get(id); if (a) a.sent = true } },
    async remove(owner: string, id: string) { const a = stored.get(id); if (!a || a.owner !== owner || a.sent) throw Error('附件無法移除'); stored.delete(id); await rm(a.value.path, { force: true }) },
  }
}
export type Attachments = ReturnType<typeof createAttachments>
