/**
 * tmux 開了 `mouse on` 時，往上滾會進入捲動模式（copy mode），之後的按鍵都被 tmux 當成捲動模式的指令，
 * shell 收不到。一般終端的習慣是「捲上去看歷史，一打字就回到輸入列」，這裡在主行程補上這個行為：
 * 看到滾輪往上的滑鼠回報後，下一個真正的按鍵送出前先叫 tmux 離開捲動模式。
 */

// SGR（1006）：ESC [ < 按鍵碼 ; 欄 ; 列 M 或 m
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g
// X10：ESC [ M 接三個位元組，第一個是按鍵碼 + 32
const X10_MOUSE = /\x1b\[M([\s\S])[\s\S]{2}/g
const FOCUS_REPORT = /\x1b\[[IO]/g

/** 按鍵碼 64 是滾輪往上；4、8、16 是 Shift、Meta、Ctrl，32 是拖曳。 */
function isWheelUpCode(code: number): boolean {
  return (code & ~(4 | 8 | 16)) === 64
}

export function hasWheelUp(data: string): boolean {
  const sgr = [...data.matchAll(SGR_MOUSE)].some((m) => isWheelUpCode(Number(m[1])))
  const x10 = [...data.matchAll(X10_MOUSE)].some((m) => isWheelUpCode((m[1] ?? '').charCodeAt(0) - 32))
  return sgr || x10
}

/** 整段只有滑鼠或焦點回報，沒有使用者打的字。 */
export function isOnlyTerminalReports(data: string): boolean {
  if (data.length === 0) return false
  return data.replace(SGR_MOUSE, '').replace(X10_MOUSE, '').replace(FOCUS_REPORT, '').length === 0
}

/**
 * 回傳一個在每段輸入寫進 pty 之前呼叫的函式。滾輪往上之後的第一段按鍵觸發一次 cancel。
 * 滾回底部時 tmux 已自己離開捲動模式，這時多叫一次 cancel 只會被 tmux 回「不在模式中」，由呼叫端吞掉。
 */
export function createCopyModeGuard(cancel: () => void): (data: string) => void {
  let scrolledUp = false
  return (data) => {
    if (hasWheelUp(data)) { scrolledUp = true; return }
    if (!scrolledUp || isOnlyTerminalReports(data)) return
    scrolledUp = false
    cancel()
  }
}
