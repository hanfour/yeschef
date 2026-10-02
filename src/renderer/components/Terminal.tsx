import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createTerminalClient } from '../terminal-client.js'
import { centerTerminal, screenSize } from '../terminal-layout.js'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

const TERMINAL_BACKGROUND = '#11150f'

/** 每格的 CSS 像素大小。xterm 沒有公開 API，FitAddon 也是讀這個值算行列，兩邊用同一個來源才對得上。 */
function cellSize(term: XTerm): { readonly width: number; readonly height: number } | undefined {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core
  return core?._renderService?.dimensions?.css?.cell
}

export function Terminal({
  endpoint,
  projectId,
  tabId,
  command,
}: {
  readonly endpoint: string
  readonly projectId: string
  /** 狀態檔裡的分頁 id,主行程拿它命名 tmux session。 */
  readonly tabId: string
  readonly command?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // shell 啟動要數秒(p10k 與各種 shim),這段期間畫面全黑,打字會被 pty 回顯但不執行。
  // 用「收到第一筆輸出」當作有東西活著的訊號,在那之前蓋一層提示。
  const startedRef = useRef(false)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    startedRef.current = false
    setStarted(false)
    const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true,
      theme: { background: TERMINAL_BACKGROUND, foreground: '#e5eadf', cursor: '#bedb9d', selectionBackground: '#bedb9d38' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // 位移套在 xterm 元素本身，FitAddon 量的是 host，不會因為位移又重算出不同的行列。
    const center = (): void => {
      const element = term.element
      const screen = screenSize(term.cols, term.rows, cellSize(term))
      // 隱藏中的分頁 host 量不到尺寸，留到切回前景時的 ResizeObserver 再算。
      if (element === undefined || screen === undefined || host.clientWidth === 0) return
      const { left, top, width } = centerTerminal({ width: host.clientWidth, height: host.clientHeight }, screen)
      element.style.marginLeft = `${left}px`
      element.style.marginTop = `${top}px`
      element.style.width = `${width}px`
    }
    const layout = (): void => { fit.fit(); center() }
    layout()
    const offResize = term.onResize(center)
    const client = createTerminalClient(endpoint, {
      onOutput: (d) => {
        if (!startedRef.current) {
          startedRef.current = true
          setStarted(true)
        }
        term.write(d)
      },
      onExit: () => term.write('\r\n[已結束]\r\n'),
      onError: () => term.write('\r\n[終端機連線失敗]\r\n'),
    })
    client.open(term.cols, term.rows, projectId, tabId, command)
    const offData = term.onData((d) => client.sendInput(d))
    const ro = new ResizeObserver(() => { layout(); client.resize(term.cols, term.rows) })
    ro.observe(host)
    // xterm 置中後四周有一圈留白，點在留白上點到的是外框，鍵盤焦點不會進 xterm。
    // 點在 xterm 本體上交給 xterm 自己處理（選字、滑鼠回報），其餘把焦點轉給它。
    const frame = host.parentElement
    const focusFromFrame = (event: MouseEvent): void => {
      if (event.target instanceof Node && term.element?.contains(event.target)) return
      event.preventDefault()
      term.focus()
    }
    frame?.addEventListener('mousedown', focusFromFrame)
    return () => { frame?.removeEventListener('mousedown', focusFromFrame); offResize.dispose(); ro.disconnect(); offData.dispose(); client.close(); term.dispose() }
  }, [endpoint, projectId, tabId, command])

  return (
    <div className="terminal-wrap" style={{ '--terminal-bg': TERMINAL_BACKGROUND } as CSSProperties}>
      <div className="terminal-host" ref={hostRef} />
      {started ? null : <div className="term-starting">終端機啟動中</div>}
    </div>
  )
}
