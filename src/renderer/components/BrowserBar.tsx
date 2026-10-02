import { useRef, useState } from 'react'
import type React from 'react'
import type { BrowserCommand, BrowserCommandResult, BrowserStatePayload } from '../../shared/browser-ipc.js'
import { Icon } from './Icon.js'
import './BrowserBar.css'

export interface BrowserBarProps {
  readonly state: BrowserStatePayload | undefined
  /** 沒有 session 時網址列預填的值(該對話的 lastUrl)。 */
  readonly fallbackUrl: string
  readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>
}

/** 網址列(每對話瀏覽器規格 §5.1)。一律作用在前景對話的瀏覽器。 */
export function BrowserBar({ state, fallbackUrl, run }: BrowserBarProps): React.ReactElement {
  const current = state?.url ?? fallbackUrl
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const send = (command: BrowserCommand): void => {
    run(command).then((result) => {
      setError(result.ok ? null : result.message)
      if (result.ok) setDraft(null)
    }).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    send({ kind: 'navigate', url: draft ?? current })
    input.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    setDraft(null)
    setError(null)
    input.current?.blur()
  }

  const hasSession = state !== undefined
  const loading = state?.loading ?? false
  return (
    <form className="browser-bar" onSubmit={onSubmit}>
      <button type="button" className="browser-bar-button" aria-label="上一頁" disabled={!(state?.canGoBack ?? false)}
        onClick={() => { send({ kind: 'back' }) }}><Icon name="back" /></button>
      <button type="button" className="browser-bar-button" aria-label="下一頁" disabled={!(state?.canGoForward ?? false)}
        onClick={() => { send({ kind: 'forward' }) }}><Icon name="forward" /></button>
      <button type="button" className="browser-bar-button" aria-label={loading ? '停止' : '重新整理'} disabled={!hasSession}
        onClick={() => { send({ kind: loading ? 'stop' : 'reload' }) }}><Icon name={loading ? 'stop' : 'reload'} /></button>
      <div className="browser-bar-field">
        <input ref={input} type="text" aria-label="網址" className="browser-bar-input" spellCheck={false} autoComplete="off"
          placeholder="輸入網址" value={draft ?? current} aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'browser-bar-error'}
          onFocus={(event) => { event.currentTarget.select() }}
          onChange={(event) => { setDraft(event.currentTarget.value); setError(null) }}
          onKeyDown={onKeyDown} />
        {error === null ? null : <p id="browser-bar-error" role="alert" className="browser-bar-error">{error}</p>}
      </div>
    </form>
  )
}
