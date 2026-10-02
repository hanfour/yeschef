import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Event } from '../shared/events.js'
import { writtenPaths } from './conversation-activity.js'
/** Persist only successful path attribution, not document contents or tool outputs. */
export function createActivityLedger(dir: string, logError: (error: Error) => void) {
  const states = new Map<string, { paths: Set<string>; pending: Map<string, { event: Event; cwd: string }>; cwd?: string; loaded: Promise<void> }>()
  let writes = Promise.resolve()
  const file = (id: string) => join(dir, `${createHash('sha256').update(id).digest('hex')}.json`)
  function get(id: string) {
    const found = states.get(id); if (found) return found
    const state: { paths: Set<string>; pending: Map<string, { event: Event; cwd: string }>; cwd?: string; loaded: Promise<void> } = { paths: new Set<string>(), pending: new Map<string, { event: Event; cwd: string }>(), loaded: Promise.resolve() }
    state.loaded = readFile(file(id), 'utf8').then(raw => {
      const paths: unknown = JSON.parse(raw)
      if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string')) throw Error('寫檔歸屬紀錄格式不正確')
      for (const path of paths) state.paths.add(path)
    }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError(error as Error) })
    states.set(id, state); return state
  }
  function save(id: string, state: ReturnType<typeof get>) {
    writes = writes.then(async () => {
      await state.loaded; await mkdir(dir, { recursive: true, mode: 0o700 })
      const temp = `${file(id)}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify([...state.paths]), { mode: 0o600 }); await rename(temp, file(id))
    }).catch(error => { logError(error as Error) })
  }
  return {
    record(id: string, paths: readonly string[]): void {
      const state = get(id)
      const added = paths.filter(path => !state.paths.has(path))
      if (!added.length) return
      for (const path of added) state.paths.add(path)
      save(id, state)
    },
    observe(id: string, cwd: string, events: readonly Event[]): void {
      if (!events.some(e => e.kind === 'tool-use' || e.kind === 'tool-result' || e.kind === 'reset' || e.kind === 'session-end' || e.kind === 'permission-denied' || e.kind === 'session-start')) return
      const state = get(id)
      let changed = false
      for (const event of events) {
        if (event.kind === 'session-start' && event.cwd && isAbsolute(event.cwd)) state.cwd = event.cwd
        if (event.kind === 'reset' || event.kind === 'session-end') state.pending.clear()
        if (event.kind === 'permission-denied') state.pending.delete(event.toolUseId)
        if (event.kind === 'tool-use' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(event.name)) state.pending.set(event.id, { event, cwd: state.cwd ?? cwd })
        if (event.kind !== 'tool-result') continue
        const tool = state.pending.get(event.id); state.pending.delete(event.id)
        if (!tool) continue
        for (const path of writtenPaths({ groups: [[tool.event, event]], warnings: [] }, tool.cwd)) {
          if (!state.paths.has(path)) { state.paths.add(path); changed = true }
        }
      }
      if (!changed) return
      save(id, state)
    },
    async read(id: string): Promise<string[]> { const state = get(id); await state.loaded; return [...state.paths] },
    async dispose() { await writes },
  }
}
export type ActivityLedger = ReturnType<typeof createActivityLedger>
