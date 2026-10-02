export const PREVIEW_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const PREVIEW_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}
const MARKDOWN_EXT: ReadonlySet<string> = new Set(['md', 'markdown'])

function extOf(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function previewKindOf(path: string): 'image' | 'markdown' | undefined {
  const ext = extOf(path)
  if (Object.hasOwn(IMAGE_MIME, ext)) return 'image'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  return undefined
}

export function imageMimeOf(path: string): string | undefined {
  const ext = extOf(path)
  return Object.hasOwn(IMAGE_MIME, ext) ? IMAGE_MIME[ext] : undefined
}

/** 分頁標題用的檔名,不含目錄。 */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}

/** 有 scheme(https:、data:、mailto:…)或 `//` 開頭的,不是專案裡的檔案。 */
function isRemote(src: string): boolean {
  return src.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)
}

function normalize(parts: readonly string[], absolute: boolean): string {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    // 往上超過起點時保留 `..`,交給主行程判斷是否跳出專案;renderer 不自己擋。
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (part === '..' && absolute) continue
    else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** Local document references may include a line suffix; access checks stay in preview:read. */
export interface PreviewLocation {
  readonly line?: number
  readonly anchor?: string
}

export function previewLocationOfLink(href: string): PreviewLocation | undefined {
  const hash = href.indexOf('#')
  if (hash !== -1) {
    let anchor = href.slice(hash + 1)
    try { anchor = decodeURIComponent(anchor) } catch { /* Keep literal malformed escapes. */ }
    const line = /^L([1-9]\d*)(?:-L?\d+)?$/i.exec(anchor)
    if (line && Number.isSafeInteger(Number(line[1]))) return { line: Number(line[1]) }
    if (anchor) return { anchor }
  }
  const line = /:([1-9]\d*)(?::\d+)?$/.exec(href.split(/[?#]/)[0] ?? '')
  return line && Number.isSafeInteger(Number(line[1])) ? { line: Number(line[1]) } : undefined
}

export function previewPathOfLink(href: string, documentPath?: string): string | undefined {
  if (href.startsWith('#') || href.startsWith('?')) return undefined
  let path = href.split(/[?#]/)[0] ?? ''
  try { path = decodeURIComponent(path) } catch { /* Keep literal malformed escapes. */ }
  path = path.replace(/:\d+(?::\d+)?$/, '')
  if (isRemote(path) || path.includes('\0') || previewKindOf(path) === undefined) return undefined
  if (documentPath === undefined || path.startsWith('/')) return path
  return normalize([...documentPath.split('/').slice(0, -1), ...path.split('/')], documentPath.startsWith('/'))
}

/**
 * 預覽 Markdown 裡的圖片路徑要交給 preview:read 的那個路徑。
 * 相對路徑以 Markdown 檔所在的目錄為基準,不是專案根目錄:README 裡的 `docs/a.png` 指的是 README 旁邊的 docs。
 * 回傳 undefined 表示是遠端或 data URL,照舊交給 <img>。
 */
export function resolveImageSrc(markdownPath: string, src: string): string | undefined {
  if (isRemote(src)) return undefined
  const bare = src.split(/[?#]/)[0] ?? ''
  let decoded = bare
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    // %zz 這種解不開的,原樣
  }
  if (decoded.startsWith('/')) return decoded
  const dir = markdownPath.split('/').slice(0, -1)
  return normalize([...dir, ...decoded.split('/')], markdownPath.startsWith('/'))
}
