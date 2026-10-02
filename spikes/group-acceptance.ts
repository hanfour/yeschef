/**
 * 群組頻道規格 §11 的七項實機驗收。由 Node 啟動正式 Electron app，
 * 透過 CDP 操作 renderer 的 DOM，並以持久化的群組訊息、主廚 task 與可見對話判斷結果。
 * 執行會使用 Claude 與 Codex 額度；Grok CLI 在子行程環境中遮蔽。
 */
import { MAIN_ENTRY, RENDERER_ENTRY, OUTPUT_NAMES, capture, cleanup, errorText, initializeProject, launchApp, prepareFixture, type CheckResult, type RuntimeContext } from './group-acceptance-runtime.js'
import { checkFive, checkOne, checkSeven, checkSix, checkThree, checkTwo, sendCodexMention } from './group-acceptance-checks.js'
import { readOptional } from './group-acceptance-state.js'

async function execute(results: Map<string, CheckResult>): Promise<void> {
  let ctx: RuntimeContext | undefined
  try {
    if (!await readOptional(MAIN_ENTRY)) throw new Error(`找不到正式 build 輸出 ${MAIN_ENTRY}，先執行 npm run build`)
    if (!await readOptional(RENDERER_ENTRY)) throw new Error(`找不到 renderer build 輸出 ${RENDERER_ENTRY}，先執行 npm run build`)
    ctx = await prepareFixture()
    await launchApp(ctx)
    await initializeProject(ctx)
    await capture(results, ctx, OUTPUT_NAMES[0], () => checkOne(ctx!))
    if (ctx.modelPoolSafe !== true) {
      const detail = '未確認允許模型只有 claude 與 codex，為避免再啟動工作者而略過後續項目'
      for (const name of OUTPUT_NAMES.slice(1)) results.set(name, { check: name, ok: false, detail })
      return
    }
    await capture(results, ctx, OUTPUT_NAMES[1], () => checkTwo(ctx!))
    await capture(results, ctx, OUTPUT_NAMES[2], () => checkThree(ctx!))
    await capture(results, ctx, OUTPUT_NAMES[3], () => sendCodexMention(ctx!))
    await capture(results, ctx, OUTPUT_NAMES[5], () => checkSix(ctx!))
    await capture(results, ctx, OUTPUT_NAMES[4], () => checkFive(ctx!))
    await capture(results, ctx, OUTPUT_NAMES[6], () => checkSeven(ctx!))
  } catch (error) {
    const reason = `spike 初始化失敗：${errorText(error)}`
    for (const name of OUTPUT_NAMES) if (!results.has(name)) results.set(name, { check: name, ok: false, detail: reason })
    process.stderr.write(`${reason}\n`)
  } finally {
    await cleanup(ctx).catch((error: unknown) => { process.stderr.write(`清理失敗：${errorText(error)}\n`) })
  }
}

async function main(): Promise<void> {
  const results = new Map<string, CheckResult>()
  await execute(results)
  for (const name of OUTPUT_NAMES) {
    const result = results.get(name) ?? { check: name, ok: false, detail: '前置步驟未完成' }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  process.exitCode = OUTPUT_NAMES.every((name) => results.get(name)?.ok === true) ? 0 : 1
}
void main().catch((error: unknown) => {
  process.stderr.write(`${errorText(error)}\n`)
  process.exitCode = 1
})
