import { expect, it } from 'vitest'
import { chooseModel, isModelUnavailableError, providerFailure } from '../src/main/chef/routing.js'
import type { ChefAttempt, ChefModel, ChefPolicy } from '../src/shared/chef.js'

it('只有提供者／transport 故障可改派；拒絕、取消和一般工作失敗不改派', () => {
  expect(providerFailure({ kind: 'session-end', isError: true, apiErrorStatus: 429 })).toBe(true)
  expect(providerFailure({ kind: 'session-end', isError: true, errorMessage: 'Claude Code process exited with code 1' })).toBe(true)
  for (const errorMessage of ['Request interrupted by user', '使用者拒絕', 'npm test failed', 'max turns reached']) expect(providerFailure({ kind: 'session-end', isError: true, errorMessage })).toBe(false)
})

const claudeModel: ChefModel = { key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude', description: '', recommended: true }
const codexModel: ChefModel = { key: 'codex:x', provider: 'codex', model: 'x', label: 'Codex', description: '', recommended: true }
const grokModel: ChefModel = { key: 'grok:g', provider: 'grok', model: 'g', label: 'Grok', description: '', recommended: true }
const codexFallback: ChefModel = { key: 'codex:fallback', provider: 'codex', model: 'fallback', label: 'Codex fallback', description: '', recommended: false }
const autoPolicy = (allowed: readonly ChefModel[]): ChefPolicy => ({ mode: 'auto', allowed: allowed.map(m => m.key), maxExecutions: 6, deadlineMinutes: 30 })
const noAttempts: readonly ChefAttempt[] = []

it('只把 HTTP 404 且明確指向不存在或不支援模型的錯誤分類為模型不可用', () => {
  const upstream = 'unexpected status 404 Not Found: Model "gpt-6-astra" is not supported by any configured account in this group, url: https://api.example.com/responses, request id: ...'
  expect(isModelUnavailableError(404, upstream)).toBe(true)
  expect(isModelUnavailableError(404, 'unexpected status 404 Not Found: /responses route was not found')).toBe(false)
  expect(isModelUnavailableError(401, 'not logged in; model gpt-6-astra is not supported')).toBe(false)
  expect(isModelUnavailableError(undefined, 'network timeout while connecting')).toBe(false)
  expect(isModelUnavailableError(404, 'model_not_found')).toBe(true)
  expect(isModelUnavailableError(404, 'Model "gpt-5" does not exist')).toBe(true)
})

// 回歸:review 舊行為是「固定換一家」,不是靠 preferredProvider。新版拿掉 review 的 base
// preference,只靠 crossCheck 加分,兩家時才不會跟舊行為的「一定換家」打平手。
it('review 兩家時一定換一家,跟舊行為一致', () => {
  const models = [claudeModel, codexModel]
  expect(chooseModel(models, autoPolicy(models), 'review', noAttempts, 'claude')?.provider).toBe('codex')
  expect(chooseModel(models, autoPolicy(models), 'review', noAttempts, 'codex')?.provider).toBe('claude')
})

it('review 三家時,上一家不會被選中', () => {
  const models = [claudeModel, codexModel, grokModel]
  const picked = chooseModel(models, autoPolicy(models), 'review', noAttempts, 'claude')
  expect(picked?.provider).not.toBe('claude')
})

it('模型不可用只排除失敗模型，同 provider 的候選仍照常排序', () => {
  const astra = { key: 'codex:astra', provider: 'codex' as const, model: 'astra', label: 'Astra', description: '', recommended: true }
  const models = [claudeModel, astra, codexFallback]
  const failed: ChefAttempt = { id: 'a', unitId: 'u', workerId: 'w', provider: 'codex', model: 'astra', status: 'failed', startedAt: 0, endedAt: 1, reason: 'HTTP 404 model unsupported', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false }
  const unavailable = { ...failed, failureKind: 'model-unavailable' as const }
  expect(chooseModel(models, autoPolicy(models), 'code', [unavailable])?.key).toBe('codex:fallback')
})

it('模型不可用 key 只在呼叫端提供的 task 範圍排除', () => {
  const astra = { key: 'codex:astra', provider: 'codex' as const, model: 'astra', label: 'Astra', description: '', recommended: true }
  const models = [claudeModel, astra, codexFallback]
  const unavailable: ChefAttempt = {
    id: 'a', unitId: 'first-unit', workerId: 'w', provider: 'codex', model: 'astra', status: 'failed',
    startedAt: 0, endedAt: 1, reason: 'HTTP 404 model unsupported', failureKind: 'model-unavailable',
    events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false,
  }
  const unavailableKeys = [`${unavailable.provider}:${unavailable.model}`]
  expect(chooseModel(models, autoPolicy(models), 'code', noAttempts, undefined, unavailableKeys)?.key).toBe('codex:fallback')
  expect(chooseModel(models, autoPolicy(models), 'code', noAttempts, undefined, [])?.key).toBe('codex:astra')
})

it('未登入仍排除整個 provider', () => {
  const models = [claudeModel, codexModel, codexFallback]
  const failed: ChefAttempt = { id: 'a', unitId: 'u', workerId: 'w', provider: 'codex', model: 'x', status: 'failed', startedAt: 0, endedAt: 1, reason: 'not logged in', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false }
  expect(chooseModel(models, autoPolicy(models), 'code', [failed])?.provider).toBe('claude')
})

it('同分時依 model/list 的 catalog 順序選擇 Codex 模型', () => {
  const models: ChefModel[] = [
    { key: 'codex:gpt-6-luna', provider: 'codex', model: 'gpt-6-luna', label: 'Luna', description: '', recommended: true },
    { key: 'codex:gpt-6-astra', provider: 'codex', model: 'gpt-6-astra', label: 'Astra', description: '', recommended: true },
    { key: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'GPT 5.5', description: '', recommended: true },
  ]
  expect(chooseModel(models, autoPolicy(models), 'code', noAttempts)?.key).toBe('codex:gpt-6-luna')
})
