/**
 * 量每多一個 browser session 多用多少記憶體(每對話瀏覽器規格 §9.3)。
 * 用跟產品同一個 createAgentView 與 attachCdp,只是不起對話。
 * 輸出兩行 JSON:量測數字 { page, counts: [{ sessions, totalKB }], perSessionKB },
 * 再加統一契約的一行 { check, ok, detail };數字有效才 exit 0,否則 exit 1。
 */
import { app, BaseWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// 這支腳本由 esbuild 打包成 cjs 再交給 electron 跑(見 package.json 的 spike:sessions),所以用 __dirname。
declare const __dirname: string
import { agentPartitionFor, createAgentView } from '../src/main/agent-view.js'
import { attachCdp } from '../src/main/cdp.js'

const COUNTS = [0, 1, 3, 6] as const
const SETTLE_MS = 3000
const page = process.argv.includes('--page=fixture')
  ? pathToFileURL(join(__dirname, 'fixtures/session-page.html')).href
  : 'about:blank'

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const totalKB = (): number => app.getAppMetrics().reduce((sum, p) => sum + p.memory.workingSetSize, 0)

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BaseWindow({ width: 1200, height: 800, show: false })
  const counts: { sessions: number; totalKB: number }[] = []
  let made = 0
  for (const target of COUNTS) {
    while (made < target) {
      const view = createAgentView({ currentProjectDir: () => join(__dirname, 'fixtures'), logError: (e) => { console.error(e) } }, agentPartitionFor(`spike-${made}`))
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
      await view.webContents.loadURL(page)
      await attachCdp(view.webContents, { onListenerError: (e) => { console.error(e) } })
      made += 1
    }
    await wait(SETTLE_MS)
    counts.push({ sessions: target, totalKB: totalKB() })
  }
  const first = counts[0]
  const last = counts.at(-1)
  const perSessionKB = first === undefined || last === undefined ? 0 : Math.round((last.totalKB - first.totalKB) / last.sessions)
  console.log(JSON.stringify({ page, counts, perSessionKB }))
  // 統一輸出契約:量完所有 COUNTS 份量、每個都拿到正數的 totalKB、算出正數的 perSessionKB 才算完成。
  const ok = counts.length === COUNTS.length && counts.every((c) => c.totalKB > 0) && perSessionKB > 0
  const summaryLine = JSON.stringify({
    check: '記憶體量測完成且數字有效',
    ok,
    detail: ok ? `page=${page} perSessionKB=${perSessionKB} counts=${JSON.stringify(counts)}` : `page=${page} counts=${JSON.stringify(counts)} perSessionKB=${perSessionKB}`,
  })
  // app.exit() 會立刻結束行程,stdout 若接管線(不是 tty)寫入是非同步的,不等 flush 完就
  // exit 會截掉這一行;用 write 的 callback 確定 flush 完再 exit。
  process.stdout.write(`${summaryLine}\n`, () => { app.exit(ok ? 0 : 1) })
}

main().catch((err: unknown) => { console.error(err); app.exit(1) })
