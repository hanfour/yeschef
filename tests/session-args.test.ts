import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionOptions } from '../src/main/session-args.js'

/**
 * 用真實目錄而非字串常數：守衛要靠 realpath 解析符號連結與大小寫，
 * 而 realpath 對不存在的路徑會拋錯，所以測試必須建出真的目錄。
 */
let root: string
let appDir: string
let projectDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeschef-args-'))
  appDir = join(root, 'yeschef')
  projectDir = join(root, 'demo-app')
  mkdirSync(appDir)
  mkdirSync(projectDir)
  mkdirSync(join(appDir, 'docs'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buildSessionOptions', () => {
  it('cwd 是使用者的專案目錄', () => {
    expect(buildSessionOptions({ projectDir, appDir }).cwd).toBe(projectDir)
  })

  it('projectDir 等於 app 自身目錄時丟錯（接縫測試）', () => {
    expect(() => buildSessionOptions({ projectDir: appDir, appDir })).toThrow('app 自身目錄')
  })

  it('大小寫變體也擋得住（macOS 檔案系統大小寫不敏感）', () => {
    const variant = join(root, 'YESCHEF')
    // 大小寫不敏感的檔案系統上，這個路徑指向同一個 inode
    expect(() => buildSessionOptions({ projectDir: variant, appDir })).toThrow('app 自身目錄')
  })

  it('尾斜線與 .. 也擋得住', () => {
    expect(() => buildSessionOptions({ projectDir: appDir + '/', appDir })).toThrow('app 自身目錄')
    expect(() => buildSessionOptions({ projectDir: join(appDir, 'docs', '..'), appDir })).toThrow(
      'app 自身目錄'
    )
  })

  it('app 目錄底下的子目錄也擋得住（逐字稿仍落在 app 的路徑樹裡）', () => {
    expect(() => buildSessionOptions({ projectDir: join(appDir, 'docs'), appDir })).toThrow(
      'app 自身目錄'
    )
  })

  it('projectDir 是相對路徑時丟錯', () => {
    expect(() => buildSessionOptions({ projectDir: './relative', appDir })).toThrow('絕對路徑')
  })

  it('projectDir 是空字串時丟錯', () => {
    expect(() => buildSessionOptions({ projectDir: '', appDir })).toThrow('絕對路徑')
  })

  it('projectDir 不存在時丟錯，訊息要能讓人看懂，且保留原始錯誤', () => {
    const missing = join(root, 'not-there')
    expect(() => buildSessionOptions({ projectDir: missing, appDir })).toThrow('projectDir 不存在')

    // cause 保留原始的 ENOENT：訊息只說「不存在」，但真正的原因也可能是權限不足
    // 或路徑中間有一段不是目錄，那些只有原始錯誤的 code 分得出來。
    let caught: unknown = null
    try {
      buildSessionOptions({ projectDir: missing, appDir })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).cause).toBeInstanceOf(Error)
    expect((caught as Error).cause).toMatchObject({ code: 'ENOENT' })
  })

  it('permissionMode 是 default，不是 manual', () => {
    // manual 過不了 typecheck，且執行期靜默降級為 default
    expect(buildSessionOptions({ projectDir, appDir }).permissionMode).toBe('default')
  })

  it('沒給 autoCompactWindow 時,輸出的 options 完全沒有 env 這個 key', () => {
    expect('env' in buildSessionOptions({ projectDir, appDir })).toBe(false)
  })

  it('給了 autoCompactWindow 時,env 帶上變數且保留傳入的基礎環境', () => {
    const options = buildSessionOptions({
      projectDir,
      appDir,
      autoCompactWindow: 100_000,
      baseEnv: { PATH: '/usr/bin', HOME: '/Users/tester' },
    })
    // SDK 的 env 是整包取代不是合併(sdk.mjs 的預設值是 {...process.env}),
    // 只給一個變數會讓子程序失去 PATH。基礎環境一定要一起帶。
    expect(options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000',
    })
  })

  it('resume 時仍帶著 env', () => {
    const options = buildSessionOptions({
      projectDir,
      appDir,
      resumeSessionId: 'abc-123',
      autoCompactWindow: 100_000,
      baseEnv: { PATH: '/usr/bin' },
    })
    expect(options.env?.['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('100000')
    expect(options.resume).toBe('abc-123')
  })

  it('baseEnv 已經有這個變數時,以傳入的 autoCompactWindow 為準', () => {
    const options = buildSessionOptions({
      projectDir,
      appDir,
      autoCompactWindow: 100_000,
      baseEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999' },
    })
    expect(options.env?.['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('100000')
  })

  it('settingSources 不含 user:全域 defaultMode 不得蓋過本 app 的批准流程', () => {
    // 省略 settingSources 時 SDK 載入 user／project／local 三層(sdk.d.ts:2051-2061),
    // 使用者的 ~/.claude/settings.json 若寫 permissions.defaultMode: "auto",
    // 讀取類工具會由模型分類器直接放行,canUseTool 不會被呼叫(sdk.d.ts:4771),
    // yeschef 的批准卡因此看不到那些工具。實測見 RESULTS-08。
    expect(buildSessionOptions({ projectDir, appDir }).settingSources).toEqual(['project', 'local'])
  })

  it('settingSources 保留 project:CLAUDE.md 只在含 project 時載入', () => {
    // sdk.d.ts:2059「Must include 'project' to load CLAUDE.md files」。
    // 傳 [] 會連專案的 CLAUDE.md 一起關掉,那不是這條缺陷要的結果。
    expect(buildSessionOptions({ projectDir, appDir }).settingSources).toContain('project')
  })

  it('resume 時仍帶著 settingSources', () => {
    expect(
      buildSessionOptions({ projectDir, appDir, resumeSessionId: 'abc-123' }).settingSources
    ).toEqual(['project', 'local'])
  })

  it('includePartialMessages 固定為 true，逐字串流的前提', () => {
    expect(buildSessionOptions({ projectDir, appDir }).includePartialMessages).toBe(true)
  })

  it('沒有 resumeSessionId 時不帶 resume', () => {
    expect(buildSessionOptions({ projectDir, appDir }).resume).toBeUndefined()
  })

  it('有 resumeSessionId 時帶進 resume', () => {
    expect(buildSessionOptions({ projectDir, appDir, resumeSessionId: 'abc-123' }).resume).toBe(
      'abc-123'
    )
  })

  it('不修改傳入的物件', () => {
    const input = { projectDir, appDir }
    const snapshot = JSON.stringify(input)
    buildSessionOptions(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
