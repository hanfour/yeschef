import type { CdpSession } from '../cdp.js'
import { EMPTY_REFS, invalidateRefs } from './refs.js'
import type { InterventionLog, InvalidationReason, RefTable } from './types.js'

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface WatchDeps {
  readonly cdp: Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>
  readonly webContents: {
    on(event: 'input-event', listener: InputListener): unknown
    off(event: 'input-event', listener: InputListener): unknown
    getURL(): string
  }
  readonly logError: (error: Error) => void
}

export interface Watcher {
  refs(): RefTable
  setRefs(table: RefTable): void
  intervention(): InterventionLog
  takeIntervention(): InterventionLog
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}

// 裁決 5：Page／Runtime 已由 cdp.ts 啟用，這裡只補三個需要監看的域。
const ENABLE_METHODS = ['DOM.enable', 'Network.enable', 'Accessibility.enable'] as const

interface FrameNavigatedParams {
  readonly frame?: { readonly parentId?: string }
}

interface AttachedToTargetParams {
  readonly sessionId: string
  readonly targetInfo?: { readonly type: string }
}

async function enableDomains(
  cdp: WatchDeps['cdp'],
  sessionId: string | undefined,
  logError: WatchDeps['logError']
): Promise<void> {
  for (const method of ENABLE_METHODS) {
    try {
      await cdp.send(method, {}, sessionId)
    } catch (error) {
      logError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export async function createWatcher(deps: WatchDeps): Promise<Watcher> {
  let refsTable: RefTable = EMPTY_REFS
  let log: InterventionLog = {
    clicks: 0,
    keys: 0,
    navigations: 0,
    fromUrl: deps.webContents.getURL(),
  }
  let agentDepth = 0

  const invalidate = (reason: InvalidationReason): void => {
    // 已失效的表保留第一個原因，避免後續事件蓋掉實際成因。
    if (refsTable.entries.size > 0 || refsTable.invalidatedBy === undefined) {
      refsTable = invalidateRefs(refsTable, reason)
    }
  }

  const onCdpEvent = (method: string, params: unknown, sessionId?: string): void => {
    if (method === 'DOM.documentUpdated') {
      invalidate('documentUpdated')
      return
    }

    if (method === 'Page.frameNavigated') {
      const p = params as FrameNavigatedParams
      const isMainFrame = sessionId === undefined && p.frame !== undefined && p.frame.parentId === undefined
      if (!isMainFrame) return
      invalidate('navigated')
      if (agentDepth === 0) {
        log = { ...log, navigations: log.navigations + 1 }
      }
      return
    }

    if (method === 'Target.attachedToTarget') {
      const p = params as AttachedToTargetParams
      // Target 事件參數可能不完整，避免事件送達時 target 已解除造成 TypeError。
      if (p.targetInfo?.type === 'iframe') {
        void enableDomains(deps.cdp, p.sessionId, deps.logError)
      }
    }
  }
  const unsubscribe = deps.cdp.onEvent(onCdpEvent)

  const onInputEvent: InputListener = (_event, input) => {
    // agent 動作期間的輸入是 CDP 合成事件，不計入使用者插手。
    if (agentDepth > 0) return
    if (input.type === 'mouseDown') {
      log = { ...log, clicks: log.clicks + 1 }
      invalidate('userInput')
    } else if (input.type === 'keyDown') {
      log = { ...log, keys: log.keys + 1 }
      invalidate('userInput')
    }
  }
  deps.webContents.on('input-event', onInputEvent)

  await enableDomains(deps.cdp, undefined, deps.logError)
  for (const target of deps.cdp.getAttachedTargets()) {
    if (target.type === 'iframe') {
      await enableDomains(deps.cdp, target.sessionId, deps.logError)
    }
  }

  return {
    refs: () => refsTable,
    setRefs: (table) => {
      refsTable = table
    },
    intervention: () => log,
    takeIntervention: () => {
      const current = log
      log = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
      return current
    },
    runAsAgent: async (fn) => {
      agentDepth += 1
      try {
        return await fn()
      } finally {
        agentDepth -= 1
      }
    },
    dispose: () => {
      unsubscribe()
      deps.webContents.off('input-event', onInputEvent)
    },
  }
}

function urlSegment(log: InterventionLog, currentUrl: string): string | null {
  if (log.fromUrl !== currentUrl) return `網址從 ${log.fromUrl} 變成 ${currentUrl}`
  if (log.navigations === 0) return null
  return `網址仍是 ${currentUrl}`
}

export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null {
  if (log.clicks === 0 && log.keys === 0 && log.navigations === 0) return null
  const base = `使用者在你上次操作後點了 ${log.clicks} 次、按了 ${log.keys} 個鍵`
  const segment = urlSegment(log, currentUrl)
  return segment === null ? base : `${base}，${segment}`
}
