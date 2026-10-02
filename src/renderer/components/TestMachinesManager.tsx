import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { MachineView, TestMachinesRequest } from '../../shared/test-machines.js'
import './SkillsManager.css'
import './TestMachinesManager.css'

interface Form { readonly id?: string; readonly name: string; readonly url: string; readonly username: string; readonly password: string; readonly passwordRequired: boolean }
const EMPTY_FORM: Form = { name: '', url: '', username: '', password: '', passwordRequired: false }

export interface TestMachinesManagerProps {
  readonly api: Pick<YesChefApi, 'manageTestMachines'>
  readonly projectId: string
  readonly projectName: string
  readonly onClose: () => void
}

/** 測試機規格 §4.2。renderer 只拿得到 hasPassword,密碼欄永遠不會被回填。 */
export function TestMachinesManager({ api, projectId, projectName, onClose }: TestMachinesManagerProps): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const [revision, setRevision] = useState(0)
  const [machines, setMachines] = useState<readonly MachineView[]>([])
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (request: TestMachinesRequest, afterOk?: () => void): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await api.manageTestMachines(request)
      if (!alive.current) return
      if (response.kind === 'error') { setError(response.message); return }
      setRevision(response.revision)
      setMachines(response.machines)
      afterOk?.()
    } catch (raw) {
      if (alive.current) setError(raw instanceof Error ? raw.message : '測試機設定讀取失敗')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  /**
   * 只在掛載時跑一次,跟其他三個對話框一樣;`projectId` 換了不會重跑,而是靠呼叫端
   * 用 `key={projectId}` 整個重新掛載(見 App.tsx)。已經 open 的 `<dialog>` 再呼叫一次
   * `showModal()` 在真實瀏覽器會丟 `InvalidStateError`,依賴陣列多列 `projectId`
   * 就會在同一個實例上重犯這件事。
   */
  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    void run({ action: 'list', projectId })
    return () => { alive.current = false }
  }, [api])

  const save = (event: React.FormEvent): void => {
    event.preventDefault()
    const machine = {
      ...(form.id === undefined ? {} : { id: form.id }),
      name: form.name, url: form.url, username: form.username,
      ...(form.password === '' ? {} : { password: form.password }),
    }
    void run({ action: 'upsert', projectId, revision, machine }, () => { setForm(EMPTY_FORM) })
  }
  const edit = (m: MachineView): void => { setForm({ id: m.id, name: m.name, url: m.url, username: m.username, password: '', passwordRequired: m.passwordNeedsReentry }); setError('') }
  const remove = (m: MachineView): void => { void run({ action: 'remove', projectId, revision, id: m.id }) }
  const field = (key: keyof Omit<Form, 'id' | 'passwordRequired'>) => (event: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [key]: event.currentTarget.value }) }

  return (
    <dialog ref={dialog} className="skills-dialog test-machines-dialog" aria-labelledby="test-machines-title" onClose={onClose}>
      <header className="skills-heading">
        <div>
          <h1 id="test-machines-title">測試機</h1>
          <p>{projectName} 的測試機。agent 只能用 view_login 登入已設定的測試機，無法查看帳密。</p>
        </div>
        <button type="button" onClick={onClose}>關閉</button>
      </header>
      <div className="skills-body">
        <ul className="test-machines-list">
          {machines.map((m) => (
            <li key={m.id}>
              <div className="test-machines-row">
                <h3>{m.name}</h3>
                <span className="test-machines-url">{m.url}</span>
                <span>{m.username}</span>
                <span className={m.hasPassword ? 'test-machines-ok' : 'test-machines-missing'}>{m.passwordNeedsReentry ? '需要重新輸入密碼' : m.hasPassword ? '已設定' : '未設定'}</span>
              </div>
              <div className="test-machines-actions">
                <button type="button" aria-label={m.passwordNeedsReentry ? `重新輸入 ${m.name} 的密碼` : `編輯 ${m.name}`} onClick={() => { edit(m) }} disabled={busy}>{m.passwordNeedsReentry ? '重新輸入密碼' : '編輯'}</button>
                <button type="button" aria-label={`刪除 ${m.name}`} onClick={() => { remove(m) }} disabled={busy}>刪除</button>
              </div>
            </li>
          ))}
        </ul>
        <form className="test-machines-form" onSubmit={save}>
          <h2>{form.id === undefined ? '新增測試機' : `編輯 ${form.name}`}</h2>
          <label>名稱<input value={form.name} onChange={field('name')} required /></label>
          <label>網址<input value={form.url} onChange={field('url')} placeholder="https://staging.example.com/login" required /></label>
          <label>帳號<input value={form.username} onChange={field('username')} autoComplete="off" required /></label>
          <label>{form.passwordRequired ? '密碼（需要重新輸入）' : '密碼'}<input type="password" value={form.password} onChange={field('password')} autoComplete="new-password"
            required={form.passwordRequired} placeholder={form.passwordRequired ? '請重新輸入密碼' : form.id === undefined ? '' : '留空表示不變'} /></label>
          {error === '' ? null : <p role="alert" className="test-machines-error">{error}</p>}
          <div className="test-machines-actions">
            {form.id === undefined ? null : <button type="button" onClick={() => { setForm(EMPTY_FORM) }}>取消編輯</button>}
            <button type="submit" className="primary" disabled={busy}>儲存</button>
          </div>
        </form>
      </div>
    </dialog>
  )
}
