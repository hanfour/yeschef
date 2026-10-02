import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PreviewReadPayload, PreviewReadResult } from '../shared/ipc.js'
import { imageMimeOf, PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MARKDOWN_MAX_BYTES, previewKindOf } from '../shared/preview.js'

export interface PreviewReadDeps {
  rootPathOf(projectId: string): string | undefined
  realpath(path: string): Promise<string>
  /** 用 stat 不用 open:stat 不會卡在具名管道上,open 會。 */
  stat(path: string): Promise<{ readonly size: number; readonly isFile: boolean }>
  readFile(path: string): Promise<Buffer>
}

const OUTSIDE = '不在專案資料夾內'
const rejected = (message: string): PreviewReadResult => ({ kind: 'rejected', message })

/** 比對 `..` 這一整段,不是字首:專案根目錄下名字以 `..` 開頭的檔案(例如 `..notes.md`)是合法的。 */
function isInside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 給預覽分頁讀一個專案檔案。renderer 在沙箱裡不能讀檔,這是唯一的路,所以四道檢查都在這裡(規格 3b)。
 * 路徑比對用 realpath:專案裡一個指向 ~/.ssh 的符號連結,字面路徑在專案內,實際不在。
 */
export async function readPreview(deps: PreviewReadDeps, payload: PreviewReadPayload): Promise<PreviewReadResult> {
  const root = deps.rootPathOf(payload.projectId)
  if (root === undefined) return rejected(`找不到專案 ${payload.projectId}`)
  const kind = previewKindOf(payload.path)
  if (kind === undefined) return rejected('只能預覽圖片與 Markdown')
  let realRoot: string
  let realFile: string
  try {
    realRoot = await deps.realpath(root)
    realFile = await deps.realpath(resolve(root, payload.path))
  } catch {
    return rejected(`找不到檔案 ${payload.path}`)
  }
  if (!isInside(realRoot, realFile)) return rejected(OUTSIDE)
  // 實際檔案的副檔名也要是同一類:專案裡一個叫 pic.png 的符號連結指向 notes.md,
  // 不能拿圖片的大小上限讀進來、再用猜不出的 mime type 交給 <img>。
  if (previewKindOf(realFile) !== kind) return rejected('只能預覽圖片與 Markdown')
  const limit = kind === 'image' ? PREVIEW_IMAGE_MAX_BYTES : PREVIEW_MARKDOWN_MAX_BYTES
  const info = await deps.stat(realFile)
  // 具名管道、socket、裝置檔都擋:agent 用 mkfifo 做一個 x.md,readFile 會永遠卡住,
  // 每次卡住佔一個同時讀取的名額,兩次之後預覽就永久失效。
  if (!info.isFile) return rejected('不是一般檔案')
  if (info.size > limit) return rejected(`檔案太大(${String(info.size)} bytes,上限 ${String(limit)})`)
  const data = await deps.readFile(realFile)
  if (kind === 'markdown') return { kind: 'markdown', text: data.toString('utf8') }
  return { kind: 'image', mimeType: imageMimeOf(realFile) ?? 'application/octet-stream', dataBase64: data.toString('base64') }
}

/** 同時最多讀幾個。一張圖最多 20 MiB,轉 base64 再經 IPC 複製,一次約佔 60 MiB。 */
export const PREVIEW_MAX_IN_FLIGHT = 2
export const TOO_MANY = '同時開啟的預覽太多,請稍後再試'

/**
 * 包一層同時讀取的上限。每次讀取都整個讀進記憶體再轉 base64,沒有上限的話,
 * 被攻陷的 renderer 連續要一百張 20 MiB 的圖會讓主行程吃掉好幾 GB。
 * 超過上限直接拒絕而不是排隊:排隊一樣會把請求堆在記憶體裡。
 */
export function createPreviewReader(
  deps: PreviewReadDeps,
  maxInFlight: number = PREVIEW_MAX_IN_FLIGHT
): (payload: PreviewReadPayload) => Promise<PreviewReadResult> {
  let inFlight = 0
  return async (payload) => {
    if (inFlight >= maxInFlight) return rejected(TOO_MANY)
    inFlight += 1
    try {
      return await readPreview(deps, payload)
    } finally {
      inFlight -= 1
    }
  }
}

