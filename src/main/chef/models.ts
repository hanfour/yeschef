import type { query } from '@anthropic-ai/claude-agent-sdk'
import type { ChefModel } from '../../shared/chef.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRpc } from '../jsonrpc-stdio.js'
import { nodeSpawnCodex, type SpawnCodex } from '../codex/client.js'
import type { CodexReasoningEffortOption } from '../codex/reasoning-effort.js'
import type { GrokCatalog } from '../grok/catalog.js'
export interface ModelCatalog { list(refresh?: boolean): Promise<{ models: ChefModel[]; notices: string[]; globalReasoningEffort?: string }> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutTomlComment(value: string): string {
  let quote = ''
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!
    if (escaped) { escaped = false; continue }
    if (quote === '"' && char === '\\') { escaped = true; continue }
    if ((char === '"' || char === "'") && (quote === '' || quote === char)) { quote = quote === '' ? char : ''; continue }
    if (char === '#' && quote === '') return value.slice(0, i)
  }
  return value
}

function parseTomlString(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'string') return parsed
  }
  if (value.startsWith("'") && value.endsWith("'") && !value.slice(1, -1).includes("'")) return value.slice(1, -1)
  throw new Error('model_reasoning_effort 不是有效的 TOML 字串')
}

export function parseGlobalReasoningEffortToml(source: string): string | undefined {
  let inTable = false
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) { inTable = true; continue }
    if (inTable) continue
    const match = /^model_reasoning_effort\s*=\s*(.*)$/.exec(line)
    if (match) return parseTomlString(withoutTomlComment(match[1]!).trim())
  }
  return undefined
}

async function fallbackGlobalReasoningEffort(logError: (error: Error) => void): Promise<string | undefined> {
  let source: string
  try { source = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8') }
  catch (cause) {
    if (isRecord(cause) && cause['code'] === 'ENOENT') return undefined
    logError(cause instanceof Error ? cause : new Error(String(cause)))
    return undefined
  }
  try { return parseGlobalReasoningEffortToml(source) }
  catch (cause) {
    logError(cause instanceof Error ? cause : new Error(String(cause)))
    return undefined
  }
}

async function globalReasoningEffort(rpc: ReturnType<typeof createRpc>, logError: (error: Error) => void): Promise<string | undefined> {
  try {
    const response: unknown = await rpc.request('config/read', { cwd: null })
    if (!isRecord(response) || !isRecord(response['config'])) throw new Error('Codex config/read 回應格式不正確')
    const effort = response['config']['model_reasoning_effort']
    if (effort === null || effort === undefined) return await fallbackGlobalReasoningEffort(logError)
    if (typeof effort !== 'string') throw new Error('Codex config/read 的 model_reasoning_effort 不是字串')
    return effort
  } catch (cause) {
    if (cause instanceof Error && /config\/read 回應|model_reasoning_effort/.test(cause.message)) logError(cause)
    return await fallbackGlobalReasoningEffort(logError)
  }
}

interface CodexCatalogResult {
  readonly models: ChefModel[]
  readonly globalReasoningEffort?: string
}

async function readClaudeModels(queryFn: typeof query, cwd: string): Promise<ChefModel[]> {
  const controller = new AbortController()
  let end!: () => void
  const stopped = new Promise<void>(resolve => { end = resolve })
  const input = { async *[Symbol.asyncIterator]() { await stopped } }
  const q = queryFn({ prompt: input, options: { cwd, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true, plugins: [], persistSession: false, permissionMode: 'default', abortController: controller } })
  const close = () => { try { q.close() } catch { /* abort still cancels initialization */ } }
  const timer = setTimeout(() => { controller.abort(); end(); close() }, 20000)
  try {
    const models = await Promise.race([q.supportedModels(), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('Claude 模型清單逾時')), { once: true }))])
    return models.map((m, i) => ({ key: `claude:${m.value}`, provider: 'claude' as const, model: m.value, label: m.displayName, description: m.description, recommended: m.value === 'default' || i === 0 }))
  } finally { clearTimeout(timer); end(); controller.abort(); close() }
}

async function readCodexModels(cwd: string, spawn: SpawnCodex, logError: (error: Error) => void): Promise<CodexCatalogResult> {
  const p = spawn(cwd), rpc = createRpc({ write: line => p.write(line), onLine: cb => p.onLine(cb) }, () => {}, 15000)
  p.onStderr(() => {})
  p.onError(error => rpc.rejectAll(error)); p.onExit(() => rpc.rejectAll(Error('Codex 模型清單連線已結束')))
  try {
    await rpc.request('initialize', { clientInfo: { name: 'yeschef-chef', version: '1.0.0' }, capabilities: {} })
    rpc.notify('initialized')
    const response = await rpc.request('model/list', { limit: 100 }) as { data?: unknown[] }
    const models = (response.data ?? []).flatMap((value): ChefModel[] => parseCodexModel(value))
    const effort = await globalReasoningEffort(rpc, logError)
    return { models, ...(effort === undefined ? {} : { globalReasoningEffort: effort }) }
  } finally { rpc.rejectAll(Error('模型清單讀取結束')); p.closeStdin(); p.kill() }
}

function parseCodexModel(value: unknown): ChefModel[] {
  if (!isRecord(value)) return []
  const id = typeof value['model'] === 'string' ? value['model'] : value['id']
  if (typeof id !== 'string' || value['hidden'] === true) return []
  const supported = Array.isArray(value['supportedReasoningEfforts'])
    ? value['supportedReasoningEfforts'].flatMap((item): CodexReasoningEffortOption[] => {
        if (!isRecord(item) || typeof item['reasoningEffort'] !== 'string') return []
        return [{ reasoningEffort: item['reasoningEffort'], description: typeof item['description'] === 'string' ? item['description'] : '' }]
      })
    : undefined
  return [{ key: `codex:${id}`, provider: 'codex', model: id, label: typeof value['displayName'] === 'string' ? value['displayName'] : id, description: typeof value['description'] === 'string' ? value['description'] : '', recommended: value['isDefault'] === true,
    ...(supported === undefined ? {} : { supportedReasoningEfforts: supported }),
    ...(typeof value['defaultReasoningEffort'] === 'string' ? { defaultReasoningEffort: value['defaultReasoningEffort'] } : {}),
  }]
}

/** grok models and history share one catalog and parser (grok spec §8.2). */
async function readGrokModels(catalog: Pick<GrokCatalog, 'models'>): Promise<ChefModel[]> {
  const models = await catalog.models()
  return models.map(m => ({ key: `grok:${m.id}`, provider: 'grok' as const, model: m.id, label: m.name, description: '', recommended: false }))
}

interface ModelCatalogResult {
  readonly models: ChefModel[]
  readonly notices: string[]
  readonly globalReasoningEffort?: string
}

async function combineModelResults(claude: Promise<ChefModel[]>, codex: Promise<CodexCatalogResult>, grok: Promise<ChefModel[]>): Promise<ModelCatalogResult> {
  const [claudeResult, codexResult, grokResult] = await Promise.allSettled([claude, codex, grok])
  const models: ChefModel[] = [], notices: string[] = []
  if (claudeResult.status === 'fulfilled') models.push(...claudeResult.value)
  else notices.push(`Claude：${claudeResult.reason instanceof Error ? claudeResult.reason.message : '模型清單不可用'}`)
  if (codexResult.status === 'fulfilled') models.push(...codexResult.value.models)
  else notices.push(`Codex：${codexResult.reason instanceof Error ? codexResult.reason.message : '模型清單不可用'}`)
  if (grokResult.status === 'fulfilled') models.push(...grokResult.value)
  else notices.push(`Grok：${grokResult.reason instanceof Error ? grokResult.reason.message : '模型清單不可用'}`)
  return {
    models: [...new Map(models.map(m => [m.key, m])).values()].slice(0, 100),
    notices,
    ...(codexResult.status === 'fulfilled' && codexResult.value.globalReasoningEffort !== undefined ? { globalReasoningEffort: codexResult.value.globalReasoningEffort } : {}),
  }
}

export function createChefModelCatalog(queryFn: typeof query, cwd: string, spawn: SpawnCodex = nodeSpawnCodex, grokCatalog: Pick<GrokCatalog, 'models'> = { models: () => Promise.resolve([]) }, logError: (error: Error) => void = () => {}): ModelCatalog {
  let cached: ModelCatalogResult | undefined
  let at = 0
  let pending: Promise<ModelCatalogResult> | undefined
  const reload = async (): Promise<ModelCatalogResult> => {
    const result = await combineModelResults(readClaudeModels(queryFn, cwd), readCodexModels(cwd, spawn, logError), readGrokModels(grokCatalog))
    cached = result
    at = Date.now()
    return result
  }
  return { async list(refresh = false) {
    if (pending) return pending
    if (!refresh && cached && Date.now() - at < 300000) return cached
    pending = reload()
    try { return await pending } finally { pending = undefined }
  } }
}
