import { app, BaseWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachCdp } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'

/** 載入完成後再等一下，讓 AX 樹算完（圖片解碼、字型套用都會改變 ignored 狀態）。 */
const SETTLE_MS = 1500

const DEFAULT_PAGE = 'tests/fixtures/view/form.html'
const DEFAULT_OUT = 'tests/fixtures/ax/form.real.json'

interface AxNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value?: unknown }
  readonly name?: { readonly value?: unknown }
  readonly backendDOMNodeId?: number
}

function argOr(index: number, fallback: string): string {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  return args[index] ?? fallback
}

function label(node: AxNode): string {
  const role = typeof node.role?.value === 'string' ? node.role.value : '(無 role)'
  const name = typeof node.name?.value === 'string' ? node.name.value : ''
  return `${role}|${name}`
}

async function run(): Promise<void> {
  const pageArg = argOr(0, DEFAULT_PAGE)
  const outArg = argOr(1, DEFAULT_OUT)
  const pageUrl = pageArg.includes('://') ? pageArg : pathToFileURL(resolve(pageArg)).href
  const outPath = resolve(outArg)

  const win = new BaseWindow({ width: 1200, height: 800 })
  const agent = createAgentView({
    // 探針沒有專案概念:用 cwd 當範圍,http/https 不受這個值影響。
    currentProjectDir: () => process.cwd(),
    logError: (error) => console.error('[spike]', error),
  }, 'persist:agent')
  win.contentView.addChildView(agent)
  agent.setBounds({ x: 0, y: 0, width: 1200, height: 800 })

  await agent.webContents.loadURL(pageUrl)
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  const cdp = await attachCdp(agent.webContents)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    const { nodes } = await cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree')

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify({ nodes }, null, 2)}\n`, 'utf8')

    console.log(`頁面：${pageUrl}`)
    console.log(`輸出：${outPath}`)
    console.log(`節點數：${nodes.length}`)
    console.log('--- ignored === false 且有 backendDOMNodeId 的節點 ---')
    for (const node of nodes) {
      if (node.ignored === false && node.backendDOMNodeId !== undefined) {
        console.log(`  ${label(node)}  backendDOMNodeId=${node.backendDOMNodeId}`)
      }
    }
  } finally {
    cdp.detach()
  }
  app.quit()
}

app
  .whenReady()
  .then(run)
  .catch((e: unknown) => {
    console.error('capture-ax 執行失敗：', e)
    app.exit(1)
  })
