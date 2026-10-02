import { useState } from 'react'
import { PROVIDER_LABELS, type Provider } from '../../shared/projects.js'
import './NewConversationForm.css'

export function NewConversationForm({ onCreate, onCancel, provider }: {
  readonly onCreate: (worktreeName?: string) => void
  readonly onCancel?: () => void
  readonly provider?: Provider
}): React.ReactElement {
  const [checked, setChecked] = useState(false)
  const [name, setName] = useState('')
  return (
    <form className="new-conversation-form" onKeyDown={event => { if (event.key === 'Escape') onCancel?.() }} onSubmit={(event) => {
      event.preventDefault()
      if (checked && name.trim() === '') return
      onCreate(checked ? name.trim() : undefined)
    }}>
      {provider && <span className="new-conversation-heading">新增 {PROVIDER_LABELS[provider].name} 對話</span>}
      <label>
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        在新的 worktree 開
      </label>
      <input
        aria-label="這個對話要做什麼"
        placeholder="這個對話要做什麼"
        value={name}
        disabled={!checked}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className="primary" disabled={checked && name.trim() === ''}>建立</button>
      {onCancel && <button type="button" onClick={onCancel}>取消</button>}
    </form>
  )
}
