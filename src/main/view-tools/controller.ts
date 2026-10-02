/**
 * 八個工具的實際動作（契約 §10.2）。這個檔只做兩件事：把契約列的公開型別與
 * 常數轉出去，以及把三組方法組成一個 ViewController。
 *
 * 拆檔的理由：八個方法加 call() 逾時、offset 重算與輸出組字放同一個檔會超過
 * 400 行（契約 §1）。切法依「共用什麼」而不是依工具數量平均切：controller-core
 * 是全部共用的零件，controller-page 共用 settle 的等待與網址檢查，controller-input
 * 共用 ref 查表、座標換算與按鍵送出，controller-eval 兩個方法不碰前兩者任何東西。
 */
import { createCore } from './controller-core.js'
import { createEvalTools } from './controller-eval.js'
import { createInputTools } from './controller-input.js'
import { createLoginTools } from './controller-login.js'
import { createPageTools } from './controller-page.js'
import type { ControllerDeps, ViewController } from './controller-types.js'

export {
  CDP_CALL_TIMEOUT_MS,
  EVAL_MAX_CHARS,
  SCREENSHOT_MAX_WIDTH,
  type ControllerDeps,
  type Credentials,
  type ToolImage,
  type ToolOutput,
  type ToolText,
  type ViewController,
} from './controller-types.js'

export function createViewController(deps: ControllerDeps): ViewController {
  const core = createCore(deps)
  const page = createPageTools(core)
  const input = createInputTools(core)
  const evalTools = createEvalTools(core)
  const login = createLoginTools(core, input)

  return {
    navigate: page.navigate,
    snapshot: page.snapshot,
    screenshot: page.screenshot,
    click: input.click,
    type: input.type,
    press: input.press,
    evaluate: evalTools.evaluate,
    requestHandoff: evalTools.requestHandoff,
    login: login.login,
  }
}
