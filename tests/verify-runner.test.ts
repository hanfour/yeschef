import { describe, expect, it, vi } from 'vitest'
import pkgJson from '../package.json' with { type: 'json' }

const pkg = pkgJson as { readonly scripts: Record<string, string> }

// readScripts() 在 verify.ts 內部用 node:fs 的 readFileSync 讀 package.json;預設仍呼叫真的
// 實作,只在「package.json 缺對應 script」那一條測試裡用 mockReturnValueOnce 換掉一次回傳值。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const { flowCommand, listFlows, parseArgs } = await import('../spikes/verify.js')
const { readFileSync } = await import('node:fs')
const mockedReadFileSync = vi.mocked(readFileSync)

const FLOW_NAMES = ['browser', 'group', 'error-intake', 'error-pull', 'grok', 'screenshots', 'contrast', 'sessions', 'memory'] as const

describe('listFlows', () => {
  it('剛好九個穩定名字,順序與內容固定', () => {
    expect(listFlows().map((f) => f.name)).toEqual([...FLOW_NAMES])
  })

  it('每個 flow 都帶完整 metadata:scriptName、description、opensElectron、costsGrokQuota', () => {
    for (const flow of listFlows()) {
      expect(typeof flow.scriptName).toBe('string')
      expect(flow.scriptName.length).toBeGreaterThan(0)
      expect(typeof flow.description).toBe('string')
      expect(flow.description.length).toBeGreaterThan(0)
      expect(typeof flow.opensElectron).toBe('boolean')
      expect(typeof flow.costsGrokQuota).toBe('boolean')
    }
  })

  it('grok 是唯一會用 grok.com 額度的 flow', () => {
    const quotaFlows = listFlows().filter((f) => f.costsGrokQuota).map((f) => f.name)
    expect(quotaFlows).toEqual(['grok'])
  })

  it('group description 說明會用 claude 與 codex 額度', () => {
    const flow = listFlows().find((item) => item.name === 'group')
    expect(flow?.description).toContain('claude')
    expect(flow?.description).toContain('codex')
  })

  it('error-pull 開 Electron 並說明驗收目的與模型額度', () => {
    const flow = listFlows().find((item) => item.name === 'error-pull')
    expect(flow?.opensElectron).toBe(true)
    expect(flow?.costsGrokQuota).toBe(false)
    expect(flow?.description).toContain('不是程式問題')
    expect(flow?.description).toContain('不開 PR')
    expect(flow?.description).toContain('claude')
    expect(flow?.description).toContain('codex')
  })

  it('browser、group、error-intake、error-pull、screenshots、sessions 會開 Electron 視窗;contrast、grok、memory 不會', () => {
    const opens = listFlows().filter((f) => f.opensElectron).map((f) => f.name).sort()
    expect(opens).toEqual(['browser', 'error-intake', 'error-pull', 'group', 'screenshots', 'sessions'])
  })
})

describe('flowCommand', () => {
  it("'browser' 對應 package.json 裡 spike:acceptance 的原始 script 字串", () => {
    expect(flowCommand('browser')).toBe(pkg.scripts['spike:acceptance'])
  })

  it('每個穩定名字都能在 package.json 裡找到對應的 spike:* script,字串完全相同', () => {
    const pairs: readonly (readonly [typeof FLOW_NAMES[number], string])[] = [
      ['browser', 'spike:acceptance'], ['group', 'spike:group'], ['error-intake', 'spike:error-intake'], ['error-pull', 'spike:error-pull'], ['grok', 'spike:grok'], ['screenshots', 'spike:screenshots'],
      ['contrast', 'spike:contrast'], ['sessions', 'spike:sessions'], ['memory', 'spike:memory'],
    ]
    for (const [name, scriptName] of pairs) {
      expect(flowCommand(name)).toBe(pkg.scripts[scriptName])
    }
  })

  it('不認得的名字回傳 undefined,不丟例外', () => {
    expect(flowCommand('does-not-exist')).toBeUndefined()
  })

  it('flow 名字有效,但 package.json 剛好缺對應的 script 時回傳 undefined', () => {
    mockedReadFileSync.mockReturnValueOnce(JSON.stringify({ scripts: {} }))
    expect(flowCommand('browser')).toBeUndefined()
  })
})

describe('parseArgs', () => {
  it('沒有參數:沒有 --dry-run、沒有 flow', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, flow: undefined })
  })

  it('只給 flow 名字:dryRun 是 false', () => {
    expect(parseArgs(['grok'])).toEqual({ dryRun: false, flow: 'grok' })
  })

  it('--dry-run 加 flow:兩個欄位都對,順序不影響', () => {
    expect(parseArgs(['--dry-run', 'grok'])).toEqual({ dryRun: true, flow: 'grok' })
    expect(parseArgs(['grok', '--dry-run'])).toEqual({ dryRun: true, flow: 'grok' })
  })

  it('只有 --dry-run 沒有 flow', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, flow: undefined })
  })
})
