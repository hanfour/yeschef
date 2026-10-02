import { describe, it, expect } from 'vitest'
import { auditSummary } from '../src/main/permissions/service.js'
import type { ApprovalRequest } from '../src/main/approval.js'

const req = (toolName: string, input: unknown): ApprovalRequest => ({ requestId: 'r', toolName, toolUseId: 't', input })

describe('auditSummary', () => {
  it('Bash：取 command，單行化並截斷至 200 字', () => {
    expect(auditSummary(req('Bash', { command: 'echo\n  hello   world' }))).toBe('echo hello world')
    const long = 'a'.repeat(300)
    const summary = auditSummary(req('Bash', { command: long }))
    expect(summary.length).toBe(200)
    expect(summary).toBe('a'.repeat(200))
  })
  it('Read/Write/Edit/MultiEdit：取 file_path，不外洩內容', () => {
    expect(auditSummary(req('Read', { file_path: '/repo/a.ts' }))).toBe('/repo/a.ts')
    expect(auditSummary(req('Write', { file_path: '/repo/b.ts', content: 'secret content' }))).toBe('/repo/b.ts')
    expect(auditSummary(req('Edit', { file_path: '/repo/c.ts', old_string: 'old', new_string: 'new' }))).toBe('/repo/c.ts')
    expect(auditSummary(req('MultiEdit', { file_path: '/repo/d.ts', edits: [{ old_string: 'x', new_string: 'y' }] }))).toBe('/repo/d.ts')
  })
  it('Codex 變更清單：取第一個路徑，超過一筆附加 (+N)', () => {
    expect(auditSummary(req('Edit', { changes: [{ path: '/repo/a.ts', diff: '+x', kind: { type: 'update' } }] }))).toBe('/repo/a.ts')
    expect(auditSummary(req('Edit', { changes: [
      { path: '/repo/a.ts', diff: '+x', kind: { type: 'update' } },
      { path: '/repo/b.ts', diff: '+y', kind: { type: 'add' } },
      { path: '/repo/c.ts', diff: '+z', kind: { type: 'add' } },
    ] }))).toBe('/repo/a.ts (+2)')
  })
  it('其他工具或無法辨識的輸入：回傳工具名稱', () => {
    expect(auditSummary(req('TodoWrite', { todos: [] }))).toBe('TodoWrite')
    expect(auditSummary(req('Write', {}))).toBe('Write')
    expect(auditSummary(req('Bash', {}))).toBe('Bash')
  })
  it('絕不含完整輸入、old_string、new_string 或檔案內容片段', () => {
    const summary = auditSummary(req('Edit', { file_path: '/repo/e.ts', old_string: 'THIS-SHOULD-NOT-APPEAR', new_string: 'NOR-THIS' }))
    expect(summary).not.toContain('THIS-SHOULD-NOT-APPEAR')
    expect(summary).not.toContain('NOR-THIS')
  })
})
