import { Component, type ErrorInfo, type ReactNode } from 'react'

interface BoundaryProps {
  readonly children: ReactNode
  readonly fallback: (error: Error) => ReactNode
}

interface BoundaryState {
  readonly error: Error | null
}

/**
 * React 的錯誤邊界只能用 class 元件寫。沒有這一層時，任何元件在渲染中丟例外，
 * 整個視窗會變成一片空白，只能重新載入（實機：錯誤收集對話框取消勾選 TLS 時發生過）。
 */
class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[yeschef] 畫面元件出錯', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error)
  }
}

/** 整個 App 的最外層：出錯時說明原因並提供重新載入。 */
export function RootBoundary({ children, reload = () => window.location.reload() }: { readonly children: ReactNode; readonly reload?: () => void }) {
  return (
    <ErrorBoundary fallback={(error) => (
      <div className="app-crash" role="alert">
        <h1>畫面發生錯誤</h1>
        <p>{error.message}</p>
        <button type="button" onClick={reload}>重新載入</button>
      </div>
    )}>
      {children}
    </ErrorBoundary>
  )
}

/** 對話框各自一層：出錯時只換掉這個對話框，主畫面照常可用。 */
export function DialogBoundary({ children, onClose }: { readonly children: ReactNode; readonly onClose: () => void }) {
  return (
    <ErrorBoundary fallback={(error) => (
      <div className="dialog-crash" role="alert">
        <p>這個視窗發生錯誤：{error.message}</p>
        <button type="button" onClick={onClose}>關閉</button>
      </div>
    )}>
      {children}
    </ErrorBoundary>
  )
}
