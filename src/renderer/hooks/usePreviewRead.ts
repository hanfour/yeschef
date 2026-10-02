import { useCallback, useEffect, useState } from 'react'
import type { PreviewReadResult, YesChefApi } from '../../shared/ipc.js'
import { queuedReader } from '../read-queue.js'

type Loaded = { readonly kind: 'loading' } | PreviewReadResult

export function usePreviewRead(
  api: Pick<YesChefApi, 'readPreview'>,
  projectId: string | undefined,
  path: string | undefined,
): { readonly loaded: Loaded; readonly retry: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  // 重試沿用讀取 effect，讓清理機制繼續擋下過期結果。
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (projectId === undefined || path === undefined) return
    let alive = true
    setLoaded({ kind: 'loading' })
    queuedReader(api)({ projectId, path }).then(
      (result) => { if (alive) setLoaded(result) },
      (err: unknown) => { if (alive) setLoaded({ kind: 'rejected', message: err instanceof Error ? err.message : String(err) }) }
    )
    // 來源切換或卸載後，舊請求不可覆蓋目前畫面。
    return () => { alive = false }
  }, [api, projectId, path, attempt])

  return { loaded, retry }
}
