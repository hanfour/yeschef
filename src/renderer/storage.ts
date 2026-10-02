const CURRENT_PREFIX = 'yeschef.'
const LEGACY_PREFIX = 'sidepane.'

export function readAppStorage(key: string): string | null {
  const current = localStorage.getItem(key)
  if (current !== null || !key.startsWith(CURRENT_PREFIX)) return current
  return localStorage.getItem(`${LEGACY_PREFIX}${key.slice(CURRENT_PREFIX.length)}`)
}

export function writeAppStorage(key: string, value: string): void {
  localStorage.setItem(key, value)
}
