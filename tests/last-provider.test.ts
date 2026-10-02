// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAST_PROVIDER_KEY, readLastProvider, writeLastProvider } from '../src/renderer/last-provider.js'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('last conversation provider storage', () => {
  it('defaults to Claude when missing or invalid, and accepts only conversation providers', () => {
    expect(readLastProvider()).toBe('claude')
    localStorage.setItem(LAST_PROVIDER_KEY, 'terminal')
    expect(readLastProvider()).toBe('claude')
    localStorage.setItem(LAST_PROVIDER_KEY, 'codex')
    expect(readLastProvider()).toBe('codex')
  })

  it('writes the selected provider and tolerates localStorage read/write failures', () => {
    writeLastProvider('grok')
    expect(localStorage.getItem(LAST_PROVIDER_KEY)).toBe('grok')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readLastProvider()).toBe('claude')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeLastProvider('codex')).not.toThrow()
  })
})
