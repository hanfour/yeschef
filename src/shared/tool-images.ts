import { isRecord } from './ipc.js'

export interface ToolImage {
  readonly mimeType: string
  readonly dataBase64: string
}

/** 只畫這幾種;其他 media_type 當成不是圖,不塞進 <img>。 */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 工具結果裡的圖片有三種形狀:
 * - Anthropic image block `{ type: 'image', source: { type: 'base64', media_type, data } }`:Claude 那條路(規格 3b 實測)。
 * - MCP 圖片 `{ type: 'image', data, mimeType }`:codex 的 mcpToolCall 原樣轉傳 MCP 內容區塊(app-server 協定 schema)。
 * - codex 的 contentItems `{ type: 'inputImage', imageUrl: 'data:…;base64,…' }`:右窗格工具回給 codex 的截圖
 *   (RESULTS-22 §1:只吃 data: URL,https 被伺服器擋掉,file:// 會走 codex 自己的 view_image)。
 * 回傳圖片本身,以及把 data 換掉時要改的那一層物件。
 */

/** `data:<mime>;base64,<payload>`。只認 base64,其他編碼一律當成不是我們畫得出來的圖。 */
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/

function asInputImage(
  item: Record<string, unknown>
): { readonly image: ToolImage; readonly redact: (note: string) => unknown } | undefined {
  const url = item['imageUrl']
  if (typeof url !== 'string') return undefined
  const matched = DATA_URL_RE.exec(url)
  if (matched === null) return undefined
  const mimeType = matched[1]
  const data = matched[2]
  if (mimeType === undefined || data === undefined || !IMAGE_TYPES.has(mimeType)) return undefined
  return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, imageUrl: note }) }
}

function asImage(item: unknown): { readonly image: ToolImage; readonly redact: (note: string) => unknown } | undefined {
  if (!isRecord(item)) return undefined
  if (item['type'] === 'inputImage') return asInputImage(item)
  if (item['type'] !== 'image') return undefined
  const source = item['source']
  if (isRecord(source)) {
    const mimeType = source['media_type']
    const data = source['data']
    if (source['type'] !== 'base64' || typeof mimeType !== 'string' || !IMAGE_TYPES.has(mimeType) || typeof data !== 'string') return undefined
    return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, source: { ...source, data: note } }) }
  }
  const mimeType = item['mimeType']
  const data = item['data']
  if (typeof mimeType !== 'string' || !IMAGE_TYPES.has(mimeType) || typeof data !== 'string') return undefined
  return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, data: note }) }
}

/** 內容區塊的陣列:Claude 直接給陣列,codex 的 MCP 結果外面包一層 `{ content: [...] }`。 */
function blocksOf(result: unknown): readonly unknown[] | undefined {
  if (Array.isArray(result)) return result
  if (isRecord(result) && Array.isArray(result['content'])) return result['content']
  return undefined
}

export function extractImages(result: unknown): readonly ToolImage[] {
  return (blocksOf(result) ?? []).flatMap((item) => {
    const found = asImage(item)
    return found === undefined ? [] : [found.image]
  })
}

/** 給文字顯示用的副本:圖片的 base64 換成一段說明,不然一張截圖會印出五萬多字。 */
export function redactImages(result: unknown): unknown {
  const blocks = blocksOf(result)
  if (blocks === undefined) return result
  const redacted = blocks.map((item) => {
    const found = asImage(item)
    return found === undefined ? item : found.redact(`(圖片,${String(found.image.dataBase64.length)} 字元,已畫在上方)`)
  })
  return isRecord(result) ? { ...result, content: redacted } : redacted
}

export function toDataUrl(image: ToolImage): string {
  return `data:${image.mimeType};base64,${image.dataBase64}`
}
