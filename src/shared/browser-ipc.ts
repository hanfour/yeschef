import { isRecord } from './ipc.js'

export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' | 'forward' | 'reload' | 'stop' }

export type BrowserCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export interface BrowserStatePayload {
  readonly conversationId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

export interface BrowserSessionEntry {
  readonly conversationId: string
  readonly busy: boolean
}

export interface BrowserSnapshot {
  readonly states: readonly BrowserStatePayload[]
  readonly sessions: readonly BrowserSessionEntry[]
}

/** 網址列的輸入上限。超過這個長度的字串不會是人打的網址。 */
export const BROWSER_URL_MAX_LENGTH = 8192
const SIMPLE_KINDS = ['back', 'forward', 'reload', 'stop'] as const

export function parseBrowserCommand(raw: unknown): BrowserCommand | null {
  if (!isRecord(raw)) return null
  const kind = raw['kind']
  if (kind === 'navigate') {
    const url = raw['url']
    if (typeof url !== 'string' || url.length > BROWSER_URL_MAX_LENGTH) return null
    return { kind, url }
  }
  const simple = SIMPLE_KINDS.find((k) => k === kind)
  return simple === undefined ? null : { kind: simple }
}

export function parseBrowserCommandResult(raw: unknown): BrowserCommandResult | null {
  if (!isRecord(raw)) return null
  if (raw['ok'] === true) return { ok: true }
  const message = raw['message']
  return raw['ok'] === false && typeof message === 'string' ? { ok: false, message } : null
}

export function parseBrowserState(raw: unknown): BrowserStatePayload | null {
  if (!isRecord(raw)) return null
  const { conversationId, url, title, loading, canGoBack, canGoForward } = raw
  if (typeof conversationId !== 'string' || typeof url !== 'string' || typeof title !== 'string') return null
  if (typeof loading !== 'boolean' || typeof canGoBack !== 'boolean' || typeof canGoForward !== 'boolean') return null
  return { conversationId, url, title, loading, canGoBack, canGoForward }
}

function parseSessionEntry(raw: unknown): BrowserSessionEntry | null {
  if (!isRecord(raw)) return null
  const { conversationId, busy } = raw
  return typeof conversationId === 'string' && typeof busy === 'boolean' ? { conversationId, busy } : null
}

function parseAll<T>(raw: unknown, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(raw)) return null
  const parsed = raw.map(parse)
  return parsed.every((item): item is T => item !== null) ? parsed : null
}

export function parseBrowserSessions(raw: unknown): readonly BrowserSessionEntry[] | null {
  return parseAll(raw, parseSessionEntry)
}

export function parseBrowserSnapshot(raw: unknown): BrowserSnapshot | null {
  if (!isRecord(raw)) return null
  const states = parseAll(raw['states'], parseBrowserState)
  const sessions = parseBrowserSessions(raw['sessions'])
  return states === null || sessions === null ? null : { states, sessions }
}
