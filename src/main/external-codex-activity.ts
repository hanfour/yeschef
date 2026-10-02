import { createHash } from 'node:crypto'
import { open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

interface Link { toolUseId: string; cwd: string; output: string; started: number; task: string }
export interface ExternalWrite { parentSessionId: string; toolUseId: string; childSessionId: string; cwd: string; paths: string[]; taskHash: string }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const token = `(?:"[^"\\n]+"|'[^'\\n]+'|[^\\s;&|<>]+)`
const unquote = (value: string) => /^['"]/.test(value) ? value.slice(1, -1) : value
/** Recover the narrow, explicit launch format we can verify; never execute transcript text. */
export function codexLaunch(command: string): { cwd: string; output: string; promptFile?: string } | null {
  const cwd = command.match(new RegExp(`^\\s*codex\\s+exec\\s+--cd\\s+(${token})(?:\\s|$)`))
  const output = command.match(new RegExp(`(?:^|\\s)>\\s*(${token})\\s+2>&1\\s*$`))
  if (!cwd?.[1] || !output?.[1]) return null
  const result = { cwd: unquote(cwd[1]), output: unquote(output[1]) }
  if (!isAbsolute(result.cwd) || !isAbsolute(result.output) || /[$`\0]/.test(result.cwd + result.output)) return null
  const promptFile = command.match(/"\$\(\s*cat\s+([^\s;|&<>"'`]+)\s*\)"/)?.[1]
  return promptFile && isAbsolute(promptFile) && !/[$`\0]/.test(promptFile) ? { ...result, promptFile } : result
}
async function boundedText(path: string, limit: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('委派紀錄超過讀取限制')
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) { const read = await file.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
    if (offset > limit) throw Error('委派紀錄超過讀取限制')
    return buffer.subarray(0, offset).toString('utf8')
  } finally { await file.close() }
}
const jsonLines = (text: string): Record<string, unknown>[] => text.split('\n').flatMap(line => { try { const value = object(JSON.parse(line)); return value ? [value] : [] } catch { return [] } })
export function completedPatchPaths(rows: readonly Record<string, unknown>[], cwd: string): string[] {
  const calls = new Map<string, { paths: Set<string>; cwd: string }>(), paths = new Set<string>()
  for (const row of rows) {
    if (row.type !== 'response_item') continue
    const p = object(row.payload); if (!p || typeof p.call_id !== 'string') continue
    if (p.type === 'function_call' && p.name === 'exec_command' && typeof p.arguments === 'string') {
      let args: Record<string, unknown> | undefined
      try { args = object(JSON.parse(p.arguments)) } catch { continue }
      if (typeof args?.cmd !== 'string' || !/^\s*apply_patch\s+<</.test(args.cmd)) continue
      // A command-local cwd overrides the child session cwd; do not attribute it to the wrong repo.
      const directory = typeof args.workdir === 'string' && isAbsolute(args.workdir) ? args.workdir : cwd
      const candidates = new Set<string>()
      for (const match of args.cmd.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
        if (match[1] && !match[1].includes('\0')) candidates.add(resolve(directory, match[1]))
      }
      calls.set(p.call_id, { paths: candidates, cwd: directory })
    }
    if (p.type !== 'function_call_output' || typeof p.output !== 'string') continue
    const call = calls.get(p.call_id); calls.delete(p.call_id)
    if (!call || !/Process exited with code 0\b/.test(p.output)) continue
    const result = p.output.match(/Success\. Updated the following files:\r?\n((?:[AMD] [^\r\n]+\r?\n?)+)/)
    if (!result?.[1]) continue
    for (const line of result[1].trimEnd().split(/\r?\n/)) {
      // Resolve output paths against the command-local directory captured in the candidate paths.
      const reported = line.slice(2)
      for (const candidate of call.paths) {
        if (isAbsolute(reported) ? candidate === resolve(reported) : candidate === resolve(call.cwd, reported)) paths.add(candidate)
      }
    }
  }
  return [...paths]
}
export async function recoverExternalCodexWrites(options: { parentSessionId: string; transcriptPath: string; codexHome: string }): Promise<{ writes: ExternalWrite[]; warnings: string[] }> {
  const rows = jsonLines(await boundedText(options.transcriptPath, 64 * 1024 * 1024))
  const launches = new Map<string, Link>(), accepted: Link[] = []
  const files = new Map<string, string>(), pendingFiles = new Map<string, { path: string; text: string }>()
  const skipped: string[] = []
  for (const row of rows) {
    if (row.sessionId !== options.parentSessionId) continue
    const message = object(row.message)
    if (!Array.isArray(message?.content)) continue
    for (const raw of message.content) {
      const block = object(raw); if (!block) continue
      if (row.type === 'assistant' && block.type === 'tool_use' && block.name === 'Write' && typeof block.id === 'string') {
        const input = object(block.input)
        if (typeof input?.file_path === 'string' && isAbsolute(input.file_path) && typeof input.content === 'string') pendingFiles.set(block.id, { path: resolve(input.file_path), text: input.content })
      }
      if (row.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') {
        const command = object(block.input)?.command
        const parsed = typeof command === 'string' ? codexLaunch(command) : null
        const started = Date.parse(String(row.timestamp))
        if (parsed && Number.isFinite(started)) {
          const task = parsed.promptFile ? files.get(resolve(parsed.promptFile)) : undefined
          if (task) launches.set(block.id, { ...parsed, toolUseId: block.id, started, task })
          else skipped.push('部分外部 Codex 委派缺少父對話可驗證的任務內容，未採用。')
        }
      }
      if (row.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const written = pendingFiles.get(block.tool_use_id); pendingFiles.delete(block.tool_use_id)
        if (written && block.is_error !== true) files.set(written.path, written.text)
        const launch = launches.get(block.tool_use_id); launches.delete(block.tool_use_id)
        if (launch && block.is_error !== true) accepted.push(launch)
      }
    }
  }
  const writes: ExternalWrite[] = [], warnings: string[] = [...skipped]
  if (accepted.length > 16) warnings.push('外部 Codex 委派超過 16 筆，部分紀錄未讀取。')
  for (const launch of accepted.slice(0, 16)) {
    try {
      const text = await boundedText(launch.output, 16 * 1024 * 1024)
      const id = text.match(/^session id:\s*([a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/m)?.[1]
      if (!id) { warnings.push('外部 Codex 紀錄缺少可驗證的 session ID。'); continue }
      const stamp = parseInt(id.replaceAll('-', '').slice(0, 12), 16)
      if (stamp < launch.started - 5000 || stamp > launch.started + 600000) { warnings.push('外部 Codex session 時間與委派不符，未採用。'); continue }
      let transcript: string | undefined
      for (const day of [-1, 0, 1]) {
        const date = new Date(stamp + day * 86400000).toISOString().slice(0, 10).replaceAll('-', '/')
        const folder = join(options.codexHome, 'sessions', date)
        let entries: string[]; try { entries = await readdir(folder) } catch { continue }
        const name = entries.find(name => name.endsWith(`-${id}.jsonl`))
        if (name) { transcript = join(folder, name); break }
      }
      if (!transcript) { warnings.push('找不到外部 Codex 的原始執行紀錄。'); continue }
      const child = jsonLines(await boundedText(transcript, 64 * 1024 * 1024))
      const metadata = object(child.find(row => row.type === 'session_meta')?.payload)
      if (metadata?.id !== id || metadata.source !== 'exec' || typeof metadata.cwd !== 'string' || await realpath(metadata.cwd) !== await realpath(launch.cwd)) { warnings.push('外部 Codex 的 session／工作目錄無法對應，未採用。'); continue }
      const taskMatches = child.some(row => { const p = object(row.payload); return row.type === 'response_item' && p?.type === 'message' && p.role === 'user' && Array.isArray(p.content) && p.content.some(raw => { const part = object(raw); return part?.type === 'input_text' && typeof part.text === 'string' && part.text.trim() === launch.task.trim() }) })
      if (!taskMatches) { warnings.push('外部 Codex 的任務內容與父對話不符，未採用。'); continue }
      const paths = completedPatchPaths(child, metadata.cwd)
      if (paths.length) writes.push({ parentSessionId: options.parentSessionId, toolUseId: launch.toolUseId, childSessionId: id, cwd: metadata.cwd, paths, taskHash: createHash('sha256').update(launch.task).digest('hex') })
    } catch { warnings.push('部分外部 Codex 委派紀錄無法驗證，未推測修改範圍。') }
  }
  return { writes, warnings: [...new Set(warnings)] }
}
