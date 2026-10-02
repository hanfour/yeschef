import { join } from 'node:path'

/**
 * Claude Code 把 transcript 放在 `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`。
 * 編碼規則以本機實際目錄名對照得出:每個非 `[a-zA-Z0-9]` 的字元換成 `-`
 * (`/a/.b` → `-a--b`)。SDK 沒有提供這個路徑,只能自己組。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPathFor(homeDir: string, cwd: string, sessionId: string): string {
  return join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
}
