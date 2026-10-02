/**
 * view_login(測試機規格 §5.2):帳密由主行程填,模型只給 ref。
 * 這裡不碰 CDP,只組合 controller-input 的 type／click 與 core 的 ref 查表;
 * 順序固定:查帳密 → origin → ref → 填帳號 → 填密碼 → 送出 → 清空密碼欄。
 */
import type { ControllerCore } from './controller-core.js'
import { text } from './controller-core.js'
import type { ToolOutput, ViewController } from './controller-types.js'
import { MSG, ViewToolError } from './errors.js'

type Input = Pick<ViewController, 'type' | 'click' | 'press'>

/** DOM.describeNode 的回傳(只取這裡會用到的兩個欄位)。 */
interface DescribedNode {
  readonly node: { readonly nodeName: string; readonly attributes?: readonly string[] }
}

const USERNAME_TYPES = new Set(['text', 'email', 'tel', 'search'])
const SUBMIT_INPUT_TYPES = new Set(['submit', 'button', 'image'])

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * C2:回傳給模型的網址只留 origin + pathname,不帶 query／hash——GET 登入表單或
 * 帶 token 的轉址常把密碼或 token 放在那兩段裡。網址真的解不開時給固定字串,
 * 不把解析不了的原始字串（可能也帶著敏感字串）直接吐回去。
 */
function safeOriginAndPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(無法解析的網址)'
  }
}

/** attributes 是攤平的 [name, value, name, value, …],大小寫不拘。 */
function attrValue(attributes: readonly string[] | undefined, name: string): string | undefined {
  if (attributes === undefined) return undefined
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i]?.toLowerCase() === name) return attributes[i + 1]
  }
  return undefined
}

export function createLoginTools(core: ControllerCore, input: Input): Pick<ViewController, 'login'> {
  /**
   * 送任何輸入之前的預檢(C1):ref 要在主框架裡,節點型別也要對得上它要扮演的角色,
   * 不然模型可以把 passwordRef 指到隨便一個同站欄位,騙主行程把密碼打進去再讀出來。
   * ref 之後在 input.type／click 裡會重新查一次,這裡只借用 core.resolveEntry 查表與
   * DOM.describeNode 的結果,兩者的回傳值都不留著用。
   */
  const describeRef = async (ref: string): Promise<DescribedNode['node']> => {
    const entry = core.resolveEntry(ref)
    // 跨站 iframe 有自己的 sessionId;同站的 iframe 跟主框架同一個行程,sessionId 是 undefined。
    if (entry.sessionId !== undefined) throw new ViewToolError(MSG.loginRefInFrame)
    try {
      const described = await core.call<DescribedNode>('DOM.describeNode', { backendNodeId: entry.backendNodeId })
      return described.node
    } catch {
      throw new ViewToolError(MSG.refDetached(ref))
    }
  }

  const checkUsernameField = async (ref: string): Promise<void> => {
    const node = await describeRef(ref)
    const type = attrValue(node.attributes, 'type')?.toLowerCase()
    const ok = node.nodeName.toUpperCase() === 'INPUT' && (type === undefined || USERNAME_TYPES.has(type))
    if (!ok) throw new ViewToolError(MSG.loginNotUsernameField(ref))
  }

  const checkPasswordField = async (ref: string): Promise<void> => {
    const node = await describeRef(ref)
    const type = attrValue(node.attributes, 'type')?.toLowerCase()
    if (node.nodeName.toUpperCase() !== 'INPUT' || type !== 'password') throw new ViewToolError(MSG.loginNotPasswordField(ref))
  }

  const checkSubmitControl = async (ref: string): Promise<void> => {
    const node = await describeRef(ref)
    const name = node.nodeName.toUpperCase()
    const type = attrValue(node.attributes, 'type')?.toLowerCase()
    const ok = name === 'BUTTON' || (name === 'INPUT' && type !== undefined && SUBMIT_INPUT_TYPES.has(type))
    if (!ok) throw new ViewToolError(MSG.loginNotSubmitButton(ref))
  }

  /**
   * 回傳前一定清空密碼欄(規格 §5.2 第 7 步)。用新的 signal:原本的可能已經中止,
   * 但清空不能跟著被略過。規格只授權在「元素已經不在(頁面跳轉了)」時略過,所以
   * 略過的判斷提前到嘗試清空之前,直接看 ref 表是不是因為導覽而失效,不靠比對
   * 例外訊息(userInput／documentUpdated 失效、ref 已從頁面上消失都不算,要記)。
   *
   * 回傳值:true 是清空成功,或因為導覽被略過(規格授權的略過);false 是清空失敗,
   * 呼叫端要在回傳文字裡加一行警告(I3)。
   */
  const clearPassword = async (passwordRef: string): Promise<boolean> => {
    if (core.deps.watcher.refs().invalidatedBy === 'navigated') return true
    try {
      await input.type(passwordRef, '', true, false, new AbortController().signal)
      return true
    } catch (raw) {
      core.deps.logError(new Error('view_login 清空密碼欄失敗，密碼可能還留在欄位裡', { cause: raw }))
      return false
    }
  }

  /** 沒有送出鈕就按 Enter:type 之後焦點還在密碼欄。click 與 press 都會自己等頁面靜默。 */
  const submit = (submitRef: string | undefined, signal: AbortSignal): Promise<ToolOutput> =>
    submitRef === undefined ? input.press('Enter', signal) : input.click(submitRef, signal)

  return {
    login: async (machine, usernameRef, passwordRef, submitRef, signal) => {
      core.guard(signal)
      const found = await core.deps.credentials(machine)
      if (found === undefined) throw new ViewToolError(MSG.machineUnknown(machine))
      if (found.password === null) throw new ViewToolError(found.passwordUnreadable ? MSG.machinePasswordUnreadable(machine) : MSG.machineNoPassword(machine))
      if (originOf(core.deps.webContents.getURL()) !== found.origin) throw new ViewToolError(MSG.originMismatch(found.origin))
      await checkUsernameField(usernameRef)
      await checkPasswordField(passwordRef)
      if (submitRef !== undefined) await checkSubmitControl(submitRef)
      await input.type(usernameRef, found.username, true, false, signal)
      let cleared = true
      try {
        await input.type(passwordRef, found.password, true, false, signal)
        await submit(submitRef, signal)
      } finally {
        cleared = await clearPassword(passwordRef)
      }
      const lines = [MSG.loggedIn(machine, safeOriginAndPath(core.deps.webContents.getURL()))]
      if (!cleared) lines.push(MSG.loginClearFailed)
      return text(lines.join('\n'))
    },
  }
}
