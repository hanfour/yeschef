import type React from 'react'
import './BrowserBar.css'

export interface BrowserEmptyProps {
  readonly lastUrl: string | null
  readonly onOpen: (url: string) => void
}

/** 前景對話還沒有瀏覽器時顯示(每對話瀏覽器規格 §5.4)。此時主行程沒有 view 疊在上面。 */
export function BrowserEmpty({ lastUrl, onOpen }: BrowserEmptyProps): React.ReactElement {
  if (lastUrl === null) return <div className="browser-empty"><p>這個對話還沒開過瀏覽器</p></div>
  return (
    <div className="browser-empty">
      <p>上次停在 <span className="browser-empty-url">{lastUrl}</span></p>
      <button type="button" onClick={() => { onOpen(lastUrl) }}>開啟</button>
    </div>
  )
}
