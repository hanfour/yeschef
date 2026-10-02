import { vi } from 'vitest'
import type {
  AttachedTargetInfo,
  CdpError,
  CdpEventListener,
  CdpSession,
  Unsubscribe,
} from '../../src/main/cdp.js'

export type SendResponder = (params: object | undefined, sessionId: string | undefined) => unknown

export interface FakeCdp extends CdpSession {
  readonly send: CdpSession['send'] & ReturnType<typeof vi.fn>
  readonly detach: CdpSession['detach'] & ReturnType<typeof vi.fn>
  onSend(method: string, responder: SendResponder, sessionId?: string): void
  emit(method: string, params: unknown, sessionId?: string): void
  setAttachedTargets(targets: readonly AttachedTargetInfo[]): void
  setRearmErrors(errors: readonly CdpError[]): void
}

export function createFakeCdp(): FakeCdp {
  let attachedTargets: readonly AttachedTargetInfo[] = []
  let rearmErrors: readonly CdpError[] = []
  const responders = new Map<string, SendResponder>()
  const listeners = new Map<number, CdpEventListener>()
  let nextListenerId = 0

  const responderKey = (method: string, sessionId?: string): string =>
    sessionId === undefined ? method : `${method}::${sessionId}`

  const onSend = (method: string, responder: SendResponder, sessionId?: string): void => {
    responders.set(responderKey(method, sessionId), responder)
  }

  const send = vi.fn(async (method: string, params?: object, sessionId?: string) => {
    const specific = sessionId === undefined ? undefined : responders.get(responderKey(method, sessionId))
    const responder = specific ?? responders.get(responderKey(method))
    if (!responder) {
      throw new Error(
        `createFakeCdp: send 沒有預錄 ${method}${sessionId === undefined ? '' : ` (sessionId=${sessionId})`} 的回應，請先呼叫 onSend 設定`
      )
    }
    return responder(params, sessionId)
  }) as unknown as FakeCdp['send']

  const detach = vi.fn(() => {}) as unknown as FakeCdp['detach']

  const onEvent = (listener: CdpEventListener): Unsubscribe => {
    const id = nextListenerId++
    listeners.set(id, listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(id)
    }
  }

  const emit = (method: string, params: unknown, sessionId?: string): void => {
    const normalized = sessionId === undefined || sessionId === '' ? undefined : sessionId
    for (const listener of [...listeners.values()]) listener(method, params, normalized)
  }

  return {
    send,
    detach,
    getAttachedTargets: () => attachedTargets,
    getRearmErrors: () => rearmErrors,
    onEvent,
    onSend,
    emit,
    setAttachedTargets: (targets) => {
      attachedTargets = [...targets]
    },
    setRearmErrors: (errors) => {
      rearmErrors = [...errors]
    },
  }
}
