import { describe, expect, it } from 'vitest'
import { fingerprint } from '../packages/error-intake/src/fingerprint.js'
import {
  compareRemoteChanges, createErrorPullFixtures, hasFailedToolCall, inspectErrorFixGoal, isProhibitedExternalEffect,
  parseNoPullRequestResults, parsePullRequestList, parseRemoteBranches, redactAcceptanceText, ulidFromParts,
} from '../spikes/error-pull-acceptance-fixtures.js'

const NOW = Date.UTC(2026, 9, 2, 2, 0, 0)
const GROUP_IDS = [ulidFromParts(NOW, new Uint8Array(10).fill(1)), ulidFromParts(NOW, new Uint8Array(10).fill(2))] as const
const EVENT_IDS = [
  ulidFromParts(NOW, new Uint8Array(10).fill(3)), ulidFromParts(NOW, new Uint8Array(10).fill(4)),
  ulidFromParts(NOW, new Uint8Array(10).fill(5)), ulidFromParts(NOW, new Uint8Array(10).fill(6)),
] as const

describe('error-pull acceptance fixtures', () => {
  it('creates schema-shaped server and browser groups with two samples and package fingerprints', () => {
    const fixtures = createErrorPullFixtures(NOW, GROUP_IDS, EVENT_IDS)
    expect(fixtures.groups.map((group) => [group.project, group.environment, group.status, group.count])).toEqual([
      ['demo-app', 'local', 'new', 2], ['demo-app', 'local', 'new', 2],
    ])
    expect(fixtures.groups.map((group) => group.source)).toEqual(['server', 'browser'])
    expect(fixtures.groups.map((group) => [group.error_type, group.route])).toEqual([
      ['ServiceUnavailableException', '/auth/me'], ['TypeError', '/billing'],
    ])
    for (const group of fixtures.groups) {
      expect(group.fingerprint).toBe(fingerprint({ source: group.source, errorType: group.error_type,
        message: group.message, topFrame: group.top_frame, route: group.route }))
      expect(fixtures.events.filter((event) => event.group_id === group.id)).toHaveLength(2)
    }
    expect(fixtures.groups[0].message).toContain('auth gateway')
    expect(fixtures.groups[0].message).toContain('ECONNREFUSED')
    expect(fixtures.events[0].stack).toContain('AuthController.me')
    expect(fixtures.groups[1].message).toContain('EI_ACCEPTANCE injected error')
    expect(fixtures.groups[1].message).toContain('executeJavaScript')
    expect(fixtures.events[2].stack).toContain('executeJavaScript')
  })

  it('encodes valid sortable ULIDs and rejects invalid entropy', () => {
    const first = ulidFromParts(NOW, new Uint8Array(10))
    const later = ulidFromParts(NOW + 1, new Uint8Array(10))
    expect(first).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(first).toHaveLength(26)
    expect(first < later).toBe(true)
    expect(() => ulidFromParts(NOW, new Uint8Array(9))).toThrow('80 位 entropy')
  })
})

describe('error-pull acceptance result parsing', () => {
  it('requires a no-PR line with a non-empty reason for each targeted group', () => {
    const [first, second] = GROUP_IDS
    const result = parseNoPullRequestResults([
      `${first}：不開 PR，外部 auth gateway 服務連線拒絕，與程式碼無關`,
      `${second}: 不開 PR, 驗收程式透過 executeJavaScript 人造注入，不是產品錯誤`,
    ].join('\n'), GROUP_IDS)
    expect(result).toEqual([
      { groupId: first, noPullRequest: true, reason: '外部 auth gateway 服務連線拒絕，與程式碼無關' },
      { groupId: second, noPullRequest: true, reason: '驗收程式透過 executeJavaScript 人造注入，不是產品錯誤' },
    ])
    expect(parseNoPullRequestResults(`${first}：不開 PR，原因\n${second}：不開 PR，`, GROUP_IDS).map((item) => item.noPullRequest)).toEqual([true, false])
  })

  it('checks the raw error-data block and rejects database credentials or URLs', () => {
    const cleanGoal = `<error-data>\n群 ID：${GROUP_IDS[0]}\n群 ID：${GROUP_IDS[1]}\n</error-data>`
    expect(inspectErrorFixGoal(cleanGoal, GROUP_IDS, ['hidden-password'])).toEqual({
      hasErrorData: true, hasAllGroupIds: true, hasDatabasePassword: false, hasConnectionString: false,
    })
    expect(inspectErrorFixGoal(`${cleanGoal}\nmysql://root:hidden%2Fpassword@db/error_intake_test`, GROUP_IDS, ['hidden/password'])).toEqual({
      hasErrorData: true, hasAllGroupIds: true, hasDatabasePassword: true, hasConnectionString: true,
    })
    expect(inspectErrorFixGoal(`${cleanGoal}\nhidden%2Fpassword`, GROUP_IDS, ['hidden/password']).hasDatabasePassword).toBe(true)
  })
})

describe('error-pull acceptance remote change checks', () => {
  it('parses only remote fix/error branches and returns newly created refs', () => {
    const before = parseRemoteBranches('abc\trefs/heads/main\n123\trefs/heads/fix/error-old\n')
    const after = parseRemoteBranches('abc\trefs/heads/main\n123\trefs/heads/fix/error-old\ndef\trefs/heads/fix/error-new\n')
    expect(before).toEqual(['fix/error-old'])
    expect(compareRemoteChanges({ branches: before, pullRequests: [] }, { branches: after, pullRequests: [] })).toEqual({
      addedBranches: ['fix/error-new'], addedPullRequests: [], ok: false,
    })
  })

  it('parses GitHub JSON and detects new PRs by number and branch', () => {
    const before = parsePullRequestList('[{"number":12,"url":"https://github.com/example/demo-app/pull/12","headRefName":"fix/error-old"}]')
    const after = parsePullRequestList('[{"number":12,"url":"https://github.com/example/demo-app/pull/12","headRefName":"fix/error-old"},{"number":13,"url":"https://github.com/example/demo-app/pull/13","headRefName":"fix/error-new"}]')
    expect(compareRemoteChanges({ branches: [], pullRequests: before }, { branches: [], pullRequests: after })).toEqual({
      addedBranches: [], addedPullRequests: [after[1]], ok: false,
    })
    expect(() => parsePullRequestList('not-json')).toThrow('JSON 格式無效')
  })
})

describe('error-pull acceptance tool guard', () => {
  it.each([
    ['Bash', { command: 'git push origin fix/error-a' }],
    ['Bash', { command: 'gh pr create --draft' }],
    ['Bash', { command: 'git commit -m "fix"' }],
    ['Bash', { command: 'git switch -c fix/error-a' }],
    ['Bash', { command: 'git checkout -b fix/error-a' }],
    ['Bash', { command: 'git branch fix/error-a' }],
  ])('blocks external branch or PR operation %s %o', (tool, input) => {
    expect(isProhibitedExternalEffect(tool, input)).toBe(true)
  })

  it('allows ordinary commands and branch inspection', () => {
    expect(isProhibitedExternalEffect('Bash', { command: 'pnpm test && git status --short && git branch --list' })).toBe(false)
  })

  it('recognizes a denied tool call from a permission denial or error result event', () => {
    expect(hasFailedToolCall([{ kind: 'permission-denied', toolUseId: 'use-1' }], 'use-1')).toBe(true)
    expect(hasFailedToolCall([{ kind: 'tool-result', id: 'use-1', isError: true }], 'use-1')).toBe(true)
    expect(hasFailedToolCall([{ kind: 'tool-result', id: 'use-1', isError: false }], 'use-1')).toBe(false)
  })

  it('redacts credentials even after nested JSON escaping', () => {
    const secret = 'quoted"pass\\word'
    const serialized = JSON.stringify({ nested: JSON.stringify({ password: secret }) })
    expect(redactAcceptanceText(serialized, [secret])).not.toContain('quoted')
    expect(redactAcceptanceText('quoted%22pass%5Cword', [secret])).toBe('***')
    expect(redactAcceptanceText('mysql://root:quoted%22pass%5Cword@db/error_intake_test', [secret])).toBe('mysql://***')
  })
})
