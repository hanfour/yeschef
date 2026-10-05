/**
 * 統一驗證入口:`npm run verify <flow>`。
 * flow 名字是穩定的,底下對應的指令仍是 package.json 既有的 `spike:*` script,
 * 這裡不重複那些 esbuild 呼叫,執行時直接讀 package.json 轉呼叫 `npm run <script>`。
 *
 * `npm run verify`(無參數):列出所有 flow,exit 0。
 * `npm run verify <flow>`:跑該 flow,把子行程的 exit code 原樣往上傳。
 * `npm run verify -- --dry-run <flow>`:只印出會執行的指令,不真的跑。
 * 不認得的 flow:把清單印到 stderr,exit 1。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FlowMeta {
  readonly name: string
  readonly scriptName: string
  readonly description: string
  readonly opensElectron: boolean
  readonly costsGrokQuota: boolean
}

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_JSON_PATH = join(HERE, '../package.json')

const FLOWS: readonly FlowMeta[] = [
  { name: 'browser', scriptName: 'spike:acceptance', opensElectron: true, costsGrokQuota: false,
    description: '測試機 view_login 與每對話瀏覽器的實機驗收' },
  { name: 'group', scriptName: 'spike:group', opensElectron: true, costsGrokQuota: false,
    description: '群組頻道七項實機驗收，會用 claude 與 codex 額度，不用 Grok' },
  { name: 'project-run', scriptName: 'spike:project-run', opensElectron: true, costsGrokQuota: false,
    description: '專案執行全自動實機驗收：右側服務、檔案重啟、停止防護、外部 kill 自動重啟；Claude 未呼叫工具時標示未驗證' },
  { name: 'error-intake', scriptName: 'spike:error-intake', opensElectron: true, costsGrokQuota: false,
    description: '錯誤收集實機驗收：執行前需設定 TARGET_REPO、TARGET_GITHUB_REPO 與 TARGET_ENV_FILE，會用 claude 與 codex 額度' },
  { name: 'error-pull', scriptName: 'spike:error-pull', opensElectron: true, costsGrokQuota: false,
    description: '拉錯誤實機驗收：交給主廚的錯誤不是程式問題，主廚不開 PR 並寫回原因，會用 claude 與 codex 額度' },
  { name: 'chef-ui-check', scriptName: 'spike:chef-ui-check', opensElectron: true, costsGrokQuota: false,
    description: '主廚驗收介面檢查實機驗收：主廚在示範專案加一張單側粗框卡片，驗收階段要抓到並處理，會用 claude 與 codex 額度' },
  { name: 'grok', scriptName: 'spike:grok', opensElectron: false, costsGrokQuota: true,
    description: 'grok ACP 對話與 MCP 串接驗收,會用 grok.com 額度' },
  { name: 'screenshots', scriptName: 'spike:screenshots', opensElectron: true, costsGrokQuota: false,
    description: '兩種外觀各截一組 UI 截圖,供 contrast 與人工審視使用' },
  { name: 'contrast', scriptName: 'spike:contrast', opensElectron: false, costsGrokQuota: false,
    description: '從既有截圖與 theme.css 算對比,不開視窗;先跑過一次 screenshots' },
  { name: 'sessions', scriptName: 'spike:sessions', opensElectron: true, costsGrokQuota: false,
    description: '每對話瀏覽器的記憶體量測' },
  { name: 'memory', scriptName: 'spike:memory', opensElectron: false, costsGrokQuota: false,
    description: '量目前執行中程序的 RSS,不另外啟動任何視窗' },
]

/** 純函式,供測試與 UI 列表共用。 */
export function listFlows(): readonly FlowMeta[] {
  return FLOWS
}

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts?: Record<string, string> }
  return pkg.scripts ?? {}
}

/** flow 對應的 package.json script 字串;不認得的 flow 回傳 undefined。 */
export function flowCommand(name: string): string | undefined {
  const flow = FLOWS.find((f) => f.name === name)
  if (flow === undefined) return undefined
  return readScripts()[flow.scriptName]
}

function describe(flow: FlowMeta): string {
  const tags = [flow.opensElectron ? '會開 Electron 視窗' : null, flow.costsGrokQuota ? '會用 grok.com 額度' : null]
    .filter((t): t is string => t !== null)
  const suffix = tags.length > 0 ? ` (${tags.join('、')})` : ''
  return `  ${flow.name.padEnd(12)} ${flow.description}${suffix}`
}

function printFlowList(write: (line: string) => void): void {
  write('可用的 flow(npm run verify <flow>):')
  for (const flow of FLOWS) write(describe(flow))
}

export function parseArgs(argv: readonly string[]): { readonly dryRun: boolean; readonly flow: string | undefined } {
  const dryRun = argv.includes('--dry-run')
  const flow = argv.find((a) => a !== '--dry-run')
  return { dryRun, flow }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const { dryRun, flow } = parseArgs(argv)
  if (flow === undefined) {
    printFlowList((line) => { process.stdout.write(`${line}\n`) })
    process.exit(0)
  }
  const meta = FLOWS.find((f) => f.name === flow)
  if (meta === undefined) {
    printFlowList((line) => { process.stderr.write(`${line}\n`) })
    process.exit(1)
  }
  // flowCommand() 真的讀一次 package.json:FLOWS 表跟 package.json 的 scripts 對不上時
  // (例如 script 被改名或刪掉),在這裡就攔下來,不是等 spawnSync 才用一個查無此 script 的
  // 名字失敗。
  const command = flowCommand(flow)
  if (command === undefined) {
    process.stderr.write(`package.json 裡找不到 flow "${flow}" 對應的 script "${meta.scriptName}"\n`)
    process.exit(1)
  }
  if (dryRun) {
    process.stdout.write(`會執行:npm run ${meta.scriptName}\n`)
    process.exit(0)
  }
  const result = spawnSync('npm', ['run', meta.scriptName], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main()
}
