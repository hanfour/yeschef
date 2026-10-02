const COMMENT_SOURCE = '\\/\\*[\\s\\S]*?\\*\\/|<!--[\\s\\S]*?-->|^[\\t ]*\\/\\/[^\\n]*'
const IGNORE_DIRECTIVE = /yeschef-ui-ignore\s+([a-z][\w-]*)(?:\s*:\s*([^\r\n]*))?/gi

function commentPattern(): RegExp {
  return new RegExp(COMMENT_SOURCE, 'gm')
}

export function stripComments(source: string): string {
  return source.replace(commentPattern(), (comment) => comment.replace(/[^\n]/g, ' '))
}

export function hasIgnore(source: string, ruleId: string): boolean {
  const escaped = ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const directive = new RegExp(`yeschef-ui-ignore\\s+${escaped}\\s*:\\s*([^\\r\\n*]+)`)
  return [...source.matchAll(commentPattern())].some((match) => {
    const raw = directive.exec(match[0]!)?.[1] ?? ''
    return raw.replace(/\s*(?:\*\/|-->)[\s]*$/, '').trim().length > 0
  })
}

export interface UiIgnoreDirective {
  readonly ruleId: string
  readonly reason: string
  readonly line: number
  readonly snippet: string
}

export function uiIgnoreDirectives(source: string): UiIgnoreDirective[] {
  return [...source.matchAll(commentPattern())].flatMap((comment) => [...comment[0]!.matchAll(IGNORE_DIRECTIVE)].map((directive) => {
    const offset = comment.index! + directive.index!
    const reason = (directive[2] ?? '').replace(/\s*(?:\*\/|-->)\s*$/, '').trim().slice(0, 2000)
    return { ruleId: directive[1]!.toLowerCase(), reason, line: lineAt(source, offset), snippet: snippetAt(source, offset) }
  }))
}

export function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

export function snippetAt(source: string, index: number): string {
  return source.slice(source.lastIndexOf('\n', index - 1) + 1, source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index)).trim().slice(0, 180)
}

export interface CssBlock {
  readonly selector: string
  readonly body: string
  readonly start: number
  readonly bodyStart: number
}

export function cssBlocks(source: string): CssBlock[] {
  const clean = stripComments(source)
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
    start: match.index!,
    bodyStart: match.index! + match[0]!.indexOf('{') + 1,
  }))
}
