import { createHash } from 'node:crypto'
import { lstat, realpath, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ApprovalRequest } from '../approval.js'
export interface Evidence { operation: 'read' | 'write'; paths: string[]; fingerprint: string; input: unknown }
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export const within = (root: string, path: string): boolean => { const p = relative(root, path); return p === '' || (!p.startsWith(`..${sep}`) && p !== '..' && !isAbsolute(p)) }
/** Do not follow symlinks even when their current destination happens to be in scope. */
async function inspectPath(root: string, path: string, write: boolean): Promise<string> {
  if (!within(root, path)) throw Error('路徑超出對話工作目錄')
  let cursor = path
  let version = 'missing'
  while (cursor !== root) {
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) throw Error('符號連結需人工批准')
      if (cursor === path) {
        if (write && (!stat.isFile() || stat.nlink > 1)) throw Error('僅自動批准一般單一連結檔案')
        if (stat.isFile()) {
          if (stat.size > 1_000_000) throw Error('檔案過大，需人工批准')
          version = hash(await readFile(path))
        } else version = `${stat.ino}:${stat.mtimeMs}`
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    cursor = dirname(cursor)
  }
  return version
}
export async function collectEvidence(request: ApprovalRequest, cwd: string): Promise<Evidence | null> {
  const input = record(request.input)
  if (!input || !isAbsolute(cwd) || input.grantRoot != null) return null
  const root = await realpath(cwd)
  let operation: Evidence['operation']
  let files: string[]
  if (['Write', 'Edit', 'MultiEdit'].includes(request.toolName)) {
    operation = 'write'
    if (Array.isArray(input.changes)) {
      if (!input.changes.length || input.changes.length > 100) return null
      files = []
      for (const raw of input.changes) {
        const change = record(raw)
        // Renames/deletes and unknown variants remain manual in this version.
        const kind = record(change?.kind)?.type
        if (!change || typeof change.path !== 'string' || typeof change.diff !== 'string' || !['add', 'update'].includes(String(kind)) || record(change.kind)?.move_path != null || record(change.kind)?.movePath != null) return null
        files.push(change.path)
      }
    } else {
      if (typeof input.file_path !== 'string') return null
      if (request.toolName === 'Write' && typeof input.content !== 'string') return null
      if (request.toolName === 'Edit' && (typeof input.old_string !== 'string' || typeof input.new_string !== 'string')) return null
      if (request.toolName === 'MultiEdit' && (!Array.isArray(input.edits) || !input.edits.length || !input.edits.every(edit => { const e = record(edit); return typeof e?.old_string === 'string' && typeof e.new_string === 'string' }))) return null
      files = [input.file_path]
    }
  } else if (request.toolName === 'Read') {
    if (typeof input.file_path !== 'string') return null
    operation = 'read'; files = [input.file_path]
  } else return null
  if (JSON.stringify(input).length > 100_000 || files.some(file => !file || file.includes('\0'))) return null
  const paths = files.map(file => {
    const absolute = resolve(cwd, file)
    return within(resolve(cwd), absolute) ? resolve(root, relative(resolve(cwd), absolute)) : absolute
  })
  const versions = await Promise.all(paths.map(path => inspectPath(root, path, operation === 'write')))
  return { operation, paths, input, fingerprint: hash({ root, paths, versions, tool: request.toolName, input }) }
}
