import { asProvider, type Provider } from '../shared/projects.js'
import { readAppStorage, writeAppStorage } from './storage.js'

export const LAST_PROVIDER_KEY = 'yeschef.lastConversationProvider'

export function readLastProvider(): Provider {
  try {
    return asProvider(readAppStorage(LAST_PROVIDER_KEY)) ?? 'claude'
  } catch {
    return 'claude'
  }
}

export function writeLastProvider(provider: Provider): void {
  try {
    writeAppStorage(LAST_PROVIDER_KEY, provider)
  } catch {
    // 下次開啟回到預設 provider 不影響目前操作。
  }
}
