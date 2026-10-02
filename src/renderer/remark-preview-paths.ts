import { previewPathOfLink } from '../shared/preview.js'

interface Node {
  type: string
  value?: string
  children?: Node[]
  url?: string
}

/** Make inline file references clickable without changing fenced code or existing links. */
export function remarkPreviewPaths() {
  return function transform(node: Node): void {
    if (node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children?.map(child => {
      if (child.type === 'inlineCode' && child.value !== undefined && previewPathOfLink(child.value) !== undefined) {
        return { type: 'link', url: child.value, children: [child] }
      }
      transform(child)
      return child
    })
  }
}
