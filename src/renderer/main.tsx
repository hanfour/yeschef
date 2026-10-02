import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { RootBoundary } from './components/ErrorBoundary.js'

const PRELOAD_MISSING_TEXT =
  'YesChef 沒有正常啟動：preload 未載入，對話功能不可用。請重新啟動應用程式。'

/**
 * 掛載點。包成函式是為了讓守衛可以 `return`：ESM 的 module 頂層不能 return。
 *
 * `window.yeschef` 由 preload 掛上去（`src/preload/bridge.ts`）。preload 沒載成功時
 * `App` 第一行 `window.yeschef` 就是 undefined，React 會在渲染中拋錯，畫面停在
 * 全白，錯誤只有開了 DevTools 才看得到。這裡先擋下來，在頁面上留一句看得懂的話。
 */
function mount(): void {
  const container = document.getElementById('root')
  if (!container) {
    throw new Error('YesChef: index.html 缺少 #root，renderer 無法掛載')
  }

  if ((window.yeschef as unknown) === undefined) {
    console.error('[yeschef] preload 未載入，window.yeschef 不存在')
    // 用 textContent 而不是 innerHTML：這段文字不需要標記，也不該開一條注入的路。
    container.textContent = PRELOAD_MISSING_TEXT
    return
  }

  createRoot(container).render(
    <StrictMode>
      <RootBoundary>
        <App />
      </RootBoundary>
    </StrictMode>
  )
}

mount()
