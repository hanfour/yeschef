import { useEffect, useState } from 'react'

/**
 * 從指定起點或 `active` 變成 true 那一刻起算的秒數,每秒更新一次;不 active 時固定 0 且不起計時器。
 *
 * 每次都用起始時間戳重算,不是把上一個值加一:視窗切到背景時 Chromium 會節流重複計時器
 * (背景超過幾分鐘後可能一分鐘才跑一次),累加的話顯示的秒數會永久落後而且追不回來。
 * 重算是自我修正的:計時器被延後才觸發,那一次就直接跳到當下正確的秒數。
 * `ask_peer` 最長要等 10 分鐘,人在這段時間切去做別的事正是這個數字要服務的情境。
 */
export function useElapsedSeconds(active: boolean, since?: number): number {
  const [seconds, setSeconds] = useState(() =>
    active && since !== undefined ? Math.max(0, Math.floor((Date.now() - since) / 1_000)) : 0)

  useEffect(() => {
    if (!active) {
      setSeconds(0)
      return
    }
    const startedAt = since ?? Date.now()
    const recount = (): void => { setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))) }
    recount()
    const timer = setInterval(recount, 1_000)
    return () => { clearInterval(timer) }
  }, [active, since])

  // 有主行程起點時直接計算，切回前景的第一幀也不顯示上一輪或零秒。
  return !active ? 0 : since === undefined ? seconds : Math.max(0, Math.floor((Date.now() - since) / 1_000))
}
