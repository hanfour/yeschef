import type { Event, WebContents } from 'electron'

export class CdpError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CdpError'
    this.code = code
  }
}

/** CDP 的錯誤形狀不固定，統一成 CdpError 才能在上層一致處理。 */
export function toCdpError(raw: unknown): CdpError {
  if (typeof raw === 'string') return new CdpError(raw, 'unknown', { cause: raw })
  if (raw && typeof raw === 'object') {
    const o = raw as { code?: unknown; message?: unknown }
    const message = typeof o.message === 'string' ? o.message : '未知的 CDP 錯誤'
    const code = o.code === undefined ? 'unknown' : String(o.code)
    return new CdpError(message, code, { cause: raw })
  }
  return new CdpError('未知的 CDP 錯誤', 'unknown', { cause: raw })
}

/** 一個透過遞迴 auto-attach 收到附著事件的 target，範圍限定在這個 CdpSession 自己。 */
export interface AttachedTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly sessionId: string
}

export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void
export type Unsubscribe = () => void

export interface CdpSession {
  /**
   * sessionId 未提供時對根 session 下指令；提供時對該子 session 下指令
   * （例如遞迴 re-arm 附著到的跨站 iframe）。實作本來就支援，這裡只是把
   * 型別補齊，讓呼叫端能實際對子 session 送指令，而不只是看得到它附著了。
   */
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  detach(): void
  /**
   * 這個 session（含所有遞迴附著到的子代 session）目前已知附著的 target。
   *
   * 用 Target.attachedToTarget / Target.detachedFromTarget 事件即時維護，範圍
   * 是「這個 session 真的收到附著事件的 target」。故意不用 Target.getTargets()：
   * 那個指令回傳整個 browser context 的全域 target 清單，會把跟這個 session
   * 無關的東西也算進來（例如其他分頁、上一次導覽殘留的 service worker），而且
   * 它的 attached 欄位語意是「有任何 client 附著」，不是「附著到我這個 session」。
   */
  getAttachedTargets(): readonly AttachedTargetInfo[]
  /**
   * 遞迴 re-arm 某個子 session 的 auto-attach 若失敗，記在這裡而不是吞掉：
   * 失敗不會中止其他子代的附著流程（避免一個壞掉的子代拖垮全部），但呼叫端
   * 要能看到「這裡曾經失敗過、那個子代往下的孫代可能沒被附著到」。
   */
  getRearmErrors(): readonly CdpError[]
  onEvent(listener: CdpEventListener): Unsubscribe
}

export interface AttachCdpOptions {
  readonly onListenerError?: (error: Error) => void
}

interface AttachedToTargetParams {
  readonly sessionId: string
  readonly targetInfo: { readonly targetId: string; readonly type: string; readonly url: string }
}

interface DetachedFromTargetParams {
  readonly sessionId: string
}

/**
 * 附著 CDP 並開啟 flat 模式的自動附著，且遞迴到任意深度。
 *
 * flatten: true 是必要的：Electron 強制 strict site isolation，跨站 iframe
 * （金流、SSO 登入框）是獨立的 OOPIF target。沒有這個設定，單一 session
 * 看不到那些 iframe，而 agent 會以為自己成功了。
 *
 * 但 flat 模式的 auto-attach 本身不會遞迴：對根 session 發一次
 * Target.setAutoAttach 只會附著到「直接」子代 target，孫代——巢狀在另一個跨站
 * iframe 內部的跨站 iframe，例如 SSO 登入按鈕 widget 裡面又包一層帳號選擇
 * 對話框——不會被附著上。這不是理論疑慮：Spike 3（跨站 iframe 覆蓋率量測）
 * 用 Google 登入按鈕頁面實測到，巢狀的 accounts.google.com iframe 在只呼叫
 * 根層 setAutoAttach 的版本裡一直是 attached: false，導致 agent 會看不到使用者
 * 正在操作的登入框。修法是監聽 Target.attachedToTarget，每收到一個新子
 * session 就對那個子 session 再發一次 Target.setAutoAttach，讓它自己的子代
 * 也被遞迴附著——Puppeteer 與 Chrome DevTools 前端都是這樣處理巢狀 OOPIF 的，
 * 不是本專案自創的技巧。
 */
export async function attachCdp(wc: WebContents, opts?: AttachCdpOptions): Promise<CdpSession> {
  const attachedTargets = new Map<string, AttachedTargetInfo>()
  const rearmErrors: CdpError[] = []
  const listeners = new Map<number, CdpEventListener>()
  let nextListenerId = 0
  let detached = false
  let onMessage: ((event: Event, method: string, params: unknown, sessionId: string) => void) | undefined
  // 這次呼叫是不是真的附著者，決定失敗時能不能 detach：如果進來時已經是別人
  // 附著的（isAttached() 已是 true），這次呼叫從未取得附著權，失敗時 detach
  // 會把那個別人正在用的 session 一起拆掉。
  let weAttached = false

  const broadcast = (method: string, params: unknown, rawSessionId: string): void => {
    const sessionId = rawSessionId === '' ? undefined : rawSessionId
    for (const listener of [...listeners.values()]) {
      try {
        listener(method, params, sessionId)
      } catch (error) {
        opts?.onListenerError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  try {
    weAttached = !wc.debugger.isAttached()
    if (weAttached) wc.debugger.attach('1.3')

    const send = async <T,>(method: string, params: object = {}, sessionId?: string): Promise<T> => {
      try {
        return (await wc.debugger.sendCommand(method, params, sessionId)) as T
      } catch (e) {
        throw toCdpError(e)
      }
    }

    const armAutoAttach = (sessionId?: string): Promise<void> =>
      send<void>(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      )

    onMessage = (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const { sessionId: childSessionId, targetInfo } = params as AttachedToTargetParams
        attachedTargets.set(childSessionId, {
          targetId: targetInfo.targetId,
          type: targetInfo.type,
          url: targetInfo.url,
          sessionId: childSessionId,
        })
        // detach() 之後再收到的附著事件不再 re-arm：session 已經在收尾，繼續發
        // 指令只會製造註定失敗的 rearmErrors，沒有意義。
        if (!detached) {
          armAutoAttach(childSessionId).catch((e: unknown) => {
            rearmErrors.push(e instanceof CdpError ? e : toCdpError(e))
          })
        }
      } else if (method === 'Target.detachedFromTarget') {
        const { sessionId: childSessionId } = params as DetachedFromTargetParams
        attachedTargets.delete(childSessionId)
      }
      if (!detached) broadcast(method, params, sessionId)
    }
    wc.debugger.on('message', onMessage)

    await send('Page.enable')
    await send('Runtime.enable')
    await armAutoAttach()

    return {
      send,
      detach: () => {
        detached = true
        if (onMessage) wc.debugger.removeListener('message', onMessage)
        wc.debugger.detach()
      },
      getAttachedTargets: () => Array.from(attachedTargets.values()),
      getRearmErrors: () => [...rearmErrors],
      onEvent: (listener) => {
        const id = nextListenerId++
        listeners.set(id, listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          listeners.delete(id)
        }
      },
    }
  } catch (e) {
    if (onMessage) {
      try {
        wc.debugger.removeListener('message', onMessage)
      } catch {
        // 不蓋掉原始錯誤，移除 listener 失敗就忽略
      }
    }
    if (weAttached) {
      try {
        wc.debugger.detach()
      } catch {
        // 不蓋掉原始錯誤，detach 失敗就忽略
      }
    }
    throw e instanceof CdpError ? e : toCdpError(e)
  }
}
