import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { createSessionOptionsFactory } from '../src/main/session-options.js'

/**
 * 與 `session-args.test.ts` 同一個理由用真實目錄：守衛靠 realpath 解析，
 * 對不存在的路徑會拋錯。
 */
let root: string
let appDir: string
let projectDir: string
let otherDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeschef-options-'))
  appDir = join(root, 'yeschef')
  projectDir = join(root, 'demo-app')
  otherDir = join(root, 'another-project')
  mkdirSync(appDir)
  mkdirSync(projectDir)
  mkdirSync(otherDir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** 只實作 `cwdOf` 的替身：工廠的型別就只要求這一個方法。 */
function storeReturning(cwd: string | undefined): { cwdOf: (id: string) => string | undefined } {
  return { cwdOf: () => cwd }
}

describe('createSessionOptionsFactory（裁決 20：resume 的 cwd 選擇）', () => {
  it('不是 resume 時 cwd 是專案目錄，也不帶 resume 欄位', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir))
    const options = factory()
    expect(options.cwd).toBe(projectDir)
    expect(options.resume).toBeUndefined()
  })

  it('resume 時 cwd 用那場對話自己的目錄，並帶上 resume id', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir))
    const options = factory('s-old')
    expect(options.cwd).toBe(otherDir)
    expect(options.resume).toBe('s-old')
  })

  it('resume 但問不到那場對話的目錄時退回專案目錄', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(undefined))
    const options = factory('s-unknown')
    expect(options.cwd).toBe(projectDir)
    expect(options.resume).toBe('s-unknown')
  })
})

/** 假的 MCP server config：型別上是合法的 stdio 設定，內容不會被執行。 */
const FAKE_SERVER: McpServerConfig = { type: 'stdio', command: 'noop' }
const SERVERS: Readonly<Record<string, McpServerConfig>> = { yeschef: FAKE_SERVER }

describe('契約 §11.1：mcpServers 只在給了的時候出現', () => {
  it('沒給 mcpServers 時 options 連這個 key 都沒有', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir))
    expect('mcpServers' in factory()).toBe(false)
    expect('mcpServers' in factory('s-old')).toBe(false)
  })

  it('給了 mcpServers 時原樣帶進 options', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    const options = factory()
    expect('mcpServers' in options).toBe(true)
    expect(options.mcpServers).toBe(SERVERS)
  })

  it('resume 時 mcpServers 一樣帶著，且不影響 cwd 與 resume 的選擇', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    const options = factory('s-old')
    expect(options.mcpServers).toEqual({ yeschef: FAKE_SERVER })
    expect(options.cwd).toBe(otherDir)
    expect(options.resume).toBe('s-old')
  })

  it('工廠每次呼叫都帶同一份 mcpServers，不是只有第一次', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    factory()
    expect(factory('s-2').mcpServers).toBe(SERVERS)
    expect(factory().mcpServers).toBe(SERVERS)
  })
})

it('all project factories use the shared plugin snapshot without enabling user permission settings', () => {
  let plugins: { type: 'local'; path: string }[] = [{ type: 'local', path: '/app/skills/revision-a/claude' }]
  const one = createSessionOptionsFactory(projectDir, appDir, storeReturning(undefined), undefined, undefined, () => plugins)
  const two = createSessionOptionsFactory(otherDir, appDir, storeReturning(undefined), undefined, undefined, () => plugins)
  const activeOptions = one()
  expect(activeOptions.plugins).toEqual(two().plugins)
  expect(activeOptions.permissionMode).toBe('default')
  expect(activeOptions.settingSources).toEqual(['project', 'local'])
  plugins = [{ type: 'local', path: '/app/skills/revision-b/claude' }]
  expect(one().plugins).toEqual(plugins)
  expect(two().plugins).toEqual(plugins)
  expect(activeOptions.plugins).toEqual([{ type: 'local', path: '/app/skills/revision-a/claude' }])
})
