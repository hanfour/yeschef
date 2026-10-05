export interface ManagedServiceRef {
  readonly pid: number
  readonly pgid: number
  readonly processName: string
  readonly port: number
  readonly command?: string
}

function shellWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote = ''
  let escaped = false
  for (const char of text) {
    if (escaped) { word += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) {
      if (word !== '') { words.push(word); word = '' }
      continue
    }
    word += char
  }
  if (word !== '') words.push(word)
  return words
}

function stages(command: string): string[] {
  return command.split(/\r?\n|;|&&|\|\||\|/).map(part => part.trim()).filter(Boolean)
}

function statements(command: string): string[] {
  return command.split(/\r?\n|;|&&|\|\|/).map(part => part.trim()).filter(Boolean)
}

function commandName(words: readonly string[]): string {
  let index = 0
  while (['sudo', 'command', 'builtin', 'env'].includes(words[index] ?? '')) index += 1
  return (words[index] ?? '').split('/').at(-1) ?? ''
}

function killedPid(command: string, services: readonly ManagedServiceRef[]): boolean {
  const words = shellWords(command)
  if (commandName(words) !== 'kill') return false
  const args = words.slice(words.indexOf(commandName(words)) + 1)
  if (args.some(arg => /^-0$/.test(arg) || /^--signal=0$/.test(arg) || /^-s0$/.test(arg))
    || args.some((arg, index) => (arg === '-s' || arg === '--signal') && args[index + 1] === '0')) return false
  let options = true
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (options && arg === '--') { options = false; continue }
    if (options && arg === '-s') { index += 1; continue }
    if (options && arg.startsWith('-') && !/^-[0-9]+$/.test(arg)) continue
    const target = Number(arg)
    if (!Number.isInteger(target)) continue
    if (services.some(service => target === service.pid || target === -service.pgid || target === service.pgid * -1)) return true
  }
  return false
}

function matchesName(command: string, services: readonly ManagedServiceRef[]): boolean {
  const words = shellWords(command)
  const name = commandName(words)
  if (name !== 'pkill' && name !== 'killall') return false
  if (words.some(word => word === '-0' || word === '-s0' || word === '--signal=0')
    || words.some((word, index) => (word === '-s' || word === '--signal') && words[index + 1] === '0')) return false
  const patterns = words.slice(words.indexOf(name) + 1).filter(word => !word.startsWith('-'))
  return services.some(service => {
    const names = [service.processName, service.command ?? ''].filter(Boolean)
    return patterns.some(pattern => names.some(value => {
      const base = value.split('/').at(-1) ?? value
      return pattern.toLowerCase() === base.toLowerCase() || value.toLowerCase().includes(pattern.toLowerCase())
        || pattern.toLowerCase().includes(base.toLowerCase())
    }))
  })
}

function portToolMatches(command: string, service: ManagedServiceRef): boolean {
  if (!/\b(?:lsof|fuser)\b/.test(command)) return false
  return new RegExp(`(?:^|\\D)${service.port}(?:\\D|$)`).test(command)
}

function killsPortTool(command: string, services: readonly ManagedServiceRef[]): boolean {
  return services.some(service => {
    const parts = stages(command)
    if (parts.some(part => commandName(shellWords(part)) === 'fuser' && portToolMatches(part, service) && /(?:^|\s)-k(?:\s|$)/.test(part))) return true
    const lsofIndex = parts.findIndex(part => commandName(shellWords(part)) === 'lsof' && portToolMatches(part, service))
    if (lsofIndex < 0) return parts.some(part => commandName(shellWords(part)) === 'kill' && /\blsof\b/.test(part) && portToolMatches(part, service))
    return parts.slice(lsofIndex + 1).some(part => {
      const words = shellWords(part)
      return commandName(words) === 'xargs' && words.slice(1).some(word => word.split('/').at(-1) === 'kill')
    })
  })
}

/** 只攔截明確指向受管 pid、程序名稱或 port 的停止命令。 */
export function blocksManagedServiceStop(command: string, services: readonly ManagedServiceRef[]): boolean {
  if (services.length === 0 || command.trim() === '') return false
  return statements(command).some(statement =>
    stages(statement).some(stage => killedPid(stage, services) || matchesName(stage, services))
      || killsPortTool(statement, services))
}
