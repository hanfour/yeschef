interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
  position?: { start: { line: number }; end: { line: number } }
}

const blocks = new Set(['p', 'pre', 'li', 'ul', 'ol', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const textOf = (node: Node): string => node.value ?? node.children?.map(textOf).join('') ?? ''

/** Scoped metadata for document navigation. No raw HTML or global document IDs. */
export function rehypeDocument() {
  return (tree: Node): void => {
    const used = new Set<string>()
    function visit(node: Node): void {
      if (node.tagName && blocks.has(node.tagName) && node.position) {
        node.properties = { ...node.properties, 'data-source-start': node.position.start.line, 'data-source-end': node.position.end.line }
      }
      if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const base = textOf(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-')
        let slug = base
        for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`
        used.add(slug)
        node.properties = { ...node.properties, 'data-preview-anchor': slug }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

/** Search rendered text across inline formatting and syntax highlighting boundaries. */
export function rehypeDocumentSearch({ query }: { query: string }) {
  return (tree: Node): void => {
    if (!query.trim()) return
    const runs: { node: Node; start: number }[] = []
    let text = ''
    function collect(node: Node): void {
      if (node.type === 'text' && node.value) {
        runs.push({ node, start: text.length })
        text += node.value
      } else {
        node.children?.forEach(collect)
        if (node.tagName && (blocks.has(node.tagName) || ['br', 'td', 'th'].includes(node.tagName))) text += '\n'
      }
    }
    collect(tree)
    const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const matches = Array.from(text.matchAll(pattern), match => ({ start: match.index, end: match.index + match[0].length }))
    let first = 0
    for (const { node, start } of runs) {
      const value = node.value ?? ''
      const end = start + value.length
      while (matches[first] && matches[first]!.end <= start) first++
      const children: Node[] = []
      let cursor = 0
      for (let index = first; matches[index] && matches[index]!.start < end; index++) {
        const match = matches[index]!
        const from = Math.max(0, match.start - start)
        const to = Math.min(value.length, match.end - start)
        if (from > cursor) children.push({ type: 'text', value: value.slice(cursor, from) })
        children.push({ type: 'element', tagName: 'mark', properties: { 'data-preview-match': index }, children: [{ type: 'text', value: value.slice(from, to) }] })
        cursor = to
      }
      if (children.length) {
        if (cursor < value.length) children.push({ type: 'text', value: value.slice(cursor) })
        node.type = 'element'
        node.tagName = 'span'
        node.properties = {}
        delete node.value
        node.children = children
      }
    }
  }
}
