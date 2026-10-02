import { useCallback, useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { WorktreeMergeResponse, WorktreeMergeStatusResponse } from '../../shared/worktree-merge.js'

export type WorktreeMergeOutcome = Exclude<WorktreeMergeResponse, { kind: 'status' }>

export interface WorktreeMergeView {
  readonly status: WorktreeMergeStatusResponse | undefined
  /** 最近一次 merge 或 abort 的結果;`aborted` 不留,放棄成功之後回到平常態。 */
  readonly outcome: WorktreeMergeOutcome | undefined
  readonly busy: boolean
  /**
   * 目前是否還卡在一個沒解完的衝突。每次 `status` 回來都照 `conflictPending` 重設,
   * `conflict`／`conflictPending` 的回應也開啟它,`merged`／`aborted` 關掉它;
   * 其他拒絕(`agentBusy`、`rootDirty`…)不動它,因為那些只是這次請求沒成功,
   * 不代表衝突已經解決或消失。
   */
  readonly conflicted: boolean
  readonly merge: () => void
  readonly abort: () => void
}

const FAILED = '合併請求失敗'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : FAILED
}

/** 開面板時查一次,合併與放棄之後各查一次,不輪詢(合併規格 §3.3)。 */
export function useWorktreeMerge(
  worktreeMerge: YesChefApi['worktreeMerge'], projectId: string, tabId: string,
): WorktreeMergeView {
  const [status, setStatus] = useState<WorktreeMergeStatusResponse>()
  const [outcome, setOutcome] = useState<WorktreeMergeOutcome>()
  const [busy, setBusy] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const alive = useRef(true)
  /** 手快連按同一顆按鈕:同一輪同步事件裡 `busy` state 還沒反映到畫面,擋不住第二次點擊,
   *  所以這裡另外開一個同步旗標,進來就立刻設,`send` 結束才放。 */
  const sending = useRef(false)
  /** 換分頁(projectId/tabId 變動)時遞增。in-flight 的請求回來時比對這個值,
   *  對不上就是舊分頁的回應,直接丟掉,不 setState、不觸發後續的 refresh。 */
  const generation = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    generation.current += 1
    sending.current = false
    setStatus(undefined)
    setOutcome(undefined)
    setBusy(false)
    setConflicted(false)
  }, [projectId, tabId])

  const refresh = useCallback(async (): Promise<void> => {
    const gen = generation.current
    try {
      const response = await worktreeMerge({ action: 'status', projectId, tabId })
      if (!alive.current || generation.current !== gen) return
      if (response.kind === 'status') {
        setStatus(response)
        // 衝突態以 status 為準:別的地方留下的 MERGE_HEAD,開面板就看得到。
        setConflicted(response.conflictPending)
      } else setOutcome(response)
    } catch (error) {
      if (alive.current && generation.current === gen) setOutcome({ kind: 'error', message: messageOf(error) })
    }
  }, [worktreeMerge, projectId, tabId])

  useEffect(() => { void refresh() }, [refresh])

  const send = useCallback(async (action: 'merge' | 'abort'): Promise<void> => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    const gen = generation.current
    try {
      const response = await worktreeMerge({ action, projectId, tabId })
      if (!alive.current || generation.current !== gen) return
      if (response.kind === 'conflict' || response.kind === 'conflictPending') setConflicted(true)
      else if (response.kind === 'merged' || response.kind === 'aborted') setConflicted(false)
      setOutcome(response.kind === 'status' || response.kind === 'aborted' ? undefined : response)
      await refresh()
    } catch (error) {
      if (alive.current && generation.current === gen) setOutcome({ kind: 'error', message: messageOf(error) })
    } finally {
      // 已經換到別的分頁的話,`sending`／`busy` 早被換分頁那個 effect 重設過,
      // 這裡不能再動它們,否則會誤放行新分頁還在進行中的請求。
      if (generation.current === gen) {
        sending.current = false
        if (alive.current) setBusy(false)
      }
    }
  }, [worktreeMerge, projectId, tabId, refresh])

  const merge = useCallback((): void => { void send('merge') }, [send])
  const abort = useCallback((): void => { void send('abort') }, [send])
  return { status, outcome, busy, conflicted, merge, abort }
}
