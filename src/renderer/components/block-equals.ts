import type { Block } from '../../shared/fold.js'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

function rawEquals(a: ToolBlock['raw'], b: ToolBlock['raw']): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.stdout === b.stdout && a.stderr === b.stderr && a.interrupted === b.interrupted
}

export function blockEquals(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.markdown === b.markdown && a.complete === b.complete
    case 'thinking':
      return b.kind === 'thinking' && a.text === b.text && a.complete === b.complete
    case 'unknown':
      return b.kind === 'unknown' && Object.is(a.raw, b.raw)
    case 'peer-question':
      return (
        b.kind === 'peer-question' &&
        a.questionId === b.questionId &&
        a.fromLinkId === b.fromLinkId &&
        a.provider === b.provider &&
        a.text === b.text
      )
    case 'compact-summary':
      return b.kind === 'compact-summary' && a.text === b.text
    case 'compact-boundary':
      return (
        b.kind === 'compact-boundary' &&
        a.trigger === b.trigger &&
        a.preTokens === b.preTokens &&
        a.postTokens === b.postTokens
      )
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.id === b.id &&
        a.name === b.name &&
        a.status === b.status &&
        a.inputPartial === b.inputPartial &&
        a.deniedReason === b.deniedReason &&
        Object.is(a.input, b.input) &&
        Object.is(a.result, b.result) &&
        rawEquals(a.raw, b.raw)
      )
  }
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((block, i) => {
    const other = b[i]
    return other !== undefined && blockEquals(block, other)
  })
}
