import { describe, expect, it } from 'vitest'
import {
  allChecksPassed,
  extractReporterEndpoint,
  checkErrorIntakeSummary,
  isPathWithin,
  missingEnvironmentNames,
  parseRootDatabaseUrl,
  portOwnerIsInWorktree,
  pullRequestUrl,
  redactSensitiveText,
  taskTimeoutMinutes,
  validateRunLabel,
} from '../spikes/error-intake-acceptance-helpers.js'

describe('error intake acceptance pure helpers', () => {
  it('only accepts the dedicated test database and never returns the full URL', () => {
    expect(parseRootDatabaseUrl('mysql://root:secret%40pass@127.0.0.1:33307/error_intake_test')).toEqual({
      host: '127.0.0.1', port: 33307, user: 'root', password: 'secret@pass',
    })
    expect(() => parseRootDatabaseUrl('mysql://root:secret@127.0.0.1/error_intake')).toThrow('error_intake_test')
  })

  it('validates run labels and applies the task timeout default', () => {
    expect(validateRunLabel('run2')).toBe('run2')
    expect(() => validateRunLabel('../run2')).toThrow('RUN_LABEL')
    expect(taskTimeoutMinutes(undefined)).toBe(150)
    expect(taskTimeoutMinutes('12')).toBe(12)
    expect(() => taskTimeoutMinutes('0')).toThrow('正整數')
  })

  it('distinguishes a worktree path from siblings and accepts only owned port CWDs', () => {
    expect(isPathWithin('/tmp/demo-app', '/tmp/demo-app/backend/.env')).toBe(true)
    expect(isPathWithin('/tmp/demo-app', '/tmp/demo-app-old/.env')).toBe(false)
    expect(portOwnerIsInWorktree('/tmp/demo-app/backend', '/tmp/demo-app')).toBe(true)
    expect(portOwnerIsInWorktree('/tmp/other', '/tmp/demo-app')).toBe(false)
    expect(portOwnerIsInWorktree(undefined, '/tmp/demo-app')).toBe(false)
  })

  it('checks environment variable names without returning values', () => {
    expect(missingEnvironmentNames([
      '# ERROR_INTAKE_DATABASE_URL=commented',
      'export ERROR_INTAKE_DATABASE_URL=mysql://hidden',
      'ERROR_INTAKE_PROJECT=demo-app',
    ].join('\n'))).toEqual(['APP_ENV'])
  })

  it('detects a positive check_error_intake result without exposing the result body', () => {
    const summary = checkErrorIntakeSummary([
      { kind: 'tool-use', id: 'call-1', name: 'mcp__chef__check_error_intake' },
      { kind: 'tool-result', id: 'call-1', content: [{ type: 'text', text: '{"ok":true,"text":"查到 2 個錯誤群"}' }] },
    ])
    expect(summary).toEqual({ called: true, counts: [2], returnedMoreThanZero: true })
    expect(checkErrorIntakeSummary([])).toEqual({ called: false, counts: [], returnedMoreThanZero: false })
  })

  it('extracts only a pull request URL and redacts credentials from recorded text', () => {
    expect(pullRequestUrl(['created https://github.com/acme/demo-app/pull/42'])).toBe('https://github.com/acme/demo-app/pull/42')
    expect(redactSensitiveText('url=mysql://root:secret@localhost/error_intake_test Bearer abc.def', ['secret']))
      .toBe('url=mysql://*** Bearer ***')
  })

  it('requires every emitted check to pass', () => {
    expect(allChecksPassed([{ check: 'a', ok: true, detail: '' }])).toBe(true)
    expect(allChecksPassed([{ check: 'a', ok: true, detail: '' }, { check: 'b', ok: false, detail: '' }])).toBe(false)
    expect(allChecksPassed([])).toBe(false)
  })
})

describe('extractReporterEndpoint', () => {
  it('取出主廚設定的同源 endpoint，不論引號與換行', () => {
    expect(extractReporterEndpoint('installErrorReporter({ endpoint: "/api/error-intake", release })')).toBe('/api/error-intake')
    expect(extractReporterEndpoint("installErrorReporter({\n  release: v,\n  endpoint: '/api/errors',\n})")).toBe('/api/errors')
  })

  it('沒有設定或不是同源路徑時回 undefined', () => {
    expect(extractReporterEndpoint('reportError(e)')).toBeUndefined()
    expect(extractReporterEndpoint('installErrorReporter({ endpoint: "https://x.test/e" })')).toBeUndefined()
  })
})
