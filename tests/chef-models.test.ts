import { describe, expect, it, vi } from 'vitest'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { createChefModelCatalog, parseGlobalReasoningEffortToml } from '../src/main/chef/models.js'
import type { GrokModel } from '../src/main/grok/client.js'
import type { CodexProcess, SpawnCodex } from '../src/main/codex/client.js'

/**
 * Claude 與 codex 那兩條路各自要一個活著的連線,這裡只驗 grok 那一段:
 * 兩者都讓它立刻失敗,結果只會留下 notices,不影響 grok 的斷言。
 */
const failingQuery = (() => { throw new Error('Claude 不可用') }) as unknown as typeof query

/** 第一個請求送出去時才報錯:onError 在 rpc 掛上待決請求之前叫沒有意義,會等到逾時。 */
const failingSpawn: SpawnCodex = () => {
  let report: (error: Error) => void = () => {}
  return {
    write: () => { report(new Error('codex 不可用')) }, closeStdin: () => {}, kill: () => {},
    onLine: () => {}, onStderr: () => {},
    onError: (cb) => { report = cb },
    onExit: () => {},
  }
}

function setup(models: readonly GrokModel[] | Error) {
  const catalog = {
    models: () => (models instanceof Error ? Promise.reject(models) : Promise.resolve(models)),
  }
  return createChefModelCatalog(failingQuery, '/p/alpha', failingSpawn, catalog)
}

function respondingSpawn(requests: Array<Record<string, unknown>>): SpawnCodex {
  return () => {
    let onLine: (line: string) => void = () => {}
    const process: CodexProcess = {
      write(line) {
        const request = JSON.parse(line) as Record<string, unknown>
        requests.push(request)
        if (typeof request['id'] !== 'number' || typeof request['method'] !== 'string') return
        const result = request['method'] === 'model/list'
          ? { data: [{ model: 'gpt-5.5', displayName: 'GPT 5.5', description: '', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'none', description: 'disabled' }, { reasoningEffort: 'xhigh', description: 'extra high' }] }] }
          : request['method'] === 'config/read' ? { config: { model_reasoning_effort: 'max' }, origins: {} } : {}
        queueMicrotask(() => onLine(`${JSON.stringify({ jsonrpc: '2.0', id: request['id'], result })}\n`))
      },
      closeStdin() {}, kill() {}, onLine(callback) { onLine = callback }, onStderr() {}, onError() {}, onExit() {},
    }
    return process
  }
}

it('Codex 模型保留 model/list 的支援清單與預設值，config/read 讀全域 effort', async () => {
  const requests: Array<Record<string, unknown>> = []
  const errors: Error[] = []
  const grok = { models: () => Promise.resolve([]) }
  const catalog = createChefModelCatalog(failingQuery, '/p/alpha', respondingSpawn(requests), grok, (error) => errors.push(error))

  const listed = await catalog.list()

  expect(listed.models.find((model) => model.key === 'codex:gpt-5.5')).toMatchObject({
    supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'xhigh' }],
    defaultReasoningEffort: 'medium',
  })
  expect(listed.globalReasoningEffort).toBe('max')
  expect(requests.find((request) => request['method'] === 'config/read')?.['params']).toEqual({ cwd: null })
  expect(errors).toEqual([])
})

it('TOML fallback 只讀全域頂層的 model_reasoning_effort', () => {
  expect(parseGlobalReasoningEffortToml('model_reasoning_effort = "max" # comment\n\n[model_providers]\nmodel_reasoning_effort = "low"')).toBe('max')
  expect(parseGlobalReasoningEffortToml('[model_providers]\nmodel_reasoning_effort = "low"')).toBeUndefined()
})

describe('Chef 的 grok 模型清單', () => {
  it('用 grokCatalog.models() 的結果,key 是 grok:<id>', async () => {
    const list = await setup([
      { id: 'grok-4.7', name: 'Grok 4.7', reasoningEfforts: ['high', 'low'] },
      { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
    ]).list()
    expect(list.models.filter((m) => m.provider === 'grok')).toEqual([
      { key: 'grok:grok-4.7', provider: 'grok', model: 'grok-4.7', label: 'Grok 4.7', description: '', recommended: false },
      { key: 'grok:grok-4-fast', provider: 'grok', model: 'grok-4-fast', label: 'Grok 4 Fast', description: '', recommended: false },
    ])
  })

  it('catalog 回空清單:沒有 grok 項,也不多一條提示', async () => {
    const list = await setup([]).list()
    expect(list.models.filter((m) => m.provider === 'grok')).toEqual([])
    expect(list.notices.some((n) => n.startsWith('Grok'))).toBe(false)
  })

  it('catalog 失敗:其他核心照常,只多一條 Grok 的提示', async () => {
    const list = await setup(new Error('PATH 找不到 grok')).list()
    expect(list.models.filter((m) => m.provider === 'grok')).toEqual([])
    expect(list.notices).toContain('Grok：PATH 找不到 grok')
  })
})
