import type { PreviewReadPayload, PreviewReadResult, YesChefApi } from '../shared/ipc.js'

/** 跟主行程的 PREVIEW_MAX_IN_FLIGHT 一樣。renderer 自己排隊,正常使用永遠不會被主行程以「太多」拒絕。 */
const MAX_IN_FLIGHT = 2

type Read = (payload: PreviewReadPayload) => Promise<PreviewReadResult>

// 所有 API 包裝都共用名額，避免每個預覽各自排隊而超出主行程上限。
let generation = 0
let inFlight = 0
let waiting: readonly (() => void)[] = []

/** 僅供測試清理共用排隊狀態；舊請求完成時不可釋放新測試的名額。 */
export function resetQueueForTests(): void {
  generation += 1
  inFlight = 0
  waiting = []
}

function release(requestGeneration: number): void {
  if (requestGeneration !== generation) return
  const [next, ...rest] = waiting
  waiting = rest
  // 有人排隊時直接交接名額，避免新請求在等待者恢復前搶走名額。
  if (next !== undefined) next()
  else inFlight -= 1
}

/** 相對路徑圖片與檔案預覽一起排隊，一次最多送出 2 個讀取。 */
export function queuedReader(api: Pick<YesChefApi, 'readPreview'>): Read {
  return async (payload) => {
    const requestGeneration = generation
    if (inFlight >= MAX_IN_FLIGHT) {
      await new Promise<void>((resolve) => { waiting = [...waiting, resolve] })
    } else {
      inFlight += 1
    }
    try {
      return await api.readPreview(payload)
    } finally {
      release(requestGeneration)
    }
  }
}
