// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectRunManager } from '../src/renderer/components/ProjectRunManager.js'
import type { ProjectRunConfig, ProjectRunResponse, ProjectRunUpdate } from '../src/shared/project-run.js'

afterEach(cleanup)

const CONFIG: ProjectRunConfig = {
  version: 1, command: 'npm run dev -- --port {port}', cwd: '.', port: 5173,
  url: 'http://127.0.0.1:{port}/', readyPath: '/', env: {}, portStrategy: 'placeholder',
  watch: { enabled: false, include: ['**/*.ts'], exclude: [] }, openInBrowser: true,
}
const state: ProjectRunResponse = {
  kind: 'state', config: CONFIG, candidates: [], logPath: '/user-data/project-run/logs/p1.log',
  snapshot: { projectId: 'p1', state: 'running', port: 5173, url: 'http://127.0.0.1:5173/', restarted: false },
  logs: Array.from({ length: 240 }, (_, index) => `line ${index}`),
}

function api(initial: ProjectRunResponse = state) {
  const calls: string[] = []
  const listeners = new Set<(update: ProjectRunUpdate) => void>()
  return {
    calls,
    api: {
      manageProjectRun: async (request: { action: string }) => {
        calls.push(request.action)
        return initial
      },
      onProjectRunUpdate: (listener: (update: ProjectRunUpdate) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

describe('ProjectRunManager', () => {
  it('顯示執行狀態、服務網址、停止與重啟操作，紀錄只呈現最後 200 行', async () => {
    const fake = api()
    render(<ProjectRunManager api={fake.api as never} projectId="p1" projectName="demo" onRevealBrowser={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('http://127.0.0.1:5173/')).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重啟' })).toBeTruthy()
    const log = screen.getByLabelText('執行紀錄')
    expect(log.textContent?.split('\n')).toContain('line 40')
    expect(log.textContent?.split('\n')).not.toContain('line 39')
  })

  it('有重啟提示時提供重新整理操作', async () => {
    const fake = api({ ...state, snapshot: { ...state.snapshot, restarted: true } })
    render(<ProjectRunManager api={fake.api as never} projectId="p1" projectName="demo" onRevealBrowser={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('服務已重啟')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
    expect(fake.calls).toContain('refresh')
  })

  it('沒有設定時顯示候選與可編輯 command、port 欄位', async () => {
    const noConfig: ProjectRunResponse = {
      kind: 'state', config: undefined, candidates: [{
        command: 'pnpm run dev', cwd: '.', port: 5173, source: 'package.json scripts.dev',
      }], logPath: '', snapshot: { projectId: 'p1', state: 'stopped', restarted: false }, logs: [],
    }
    render(<ProjectRunManager api={api(noConfig).api as never} projectId="p1" projectName="demo" onRevealBrowser={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('package.json scripts.dev')).toBeTruthy()
    expect(screen.getByLabelText('啟動指令')).toBeTruthy()
    expect(screen.getByLabelText('連接埠')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存並執行' })).toBeTruthy()
  })

  it('候選未偵測到連接埠時留空並要求使用者填寫', async () => {
    const noPort: ProjectRunResponse = {
      kind: 'state', config: undefined, candidates: [{
        command: 'python3 server.py', cwd: '.', port: null, source: 'Python server.py',
      }], logPath: '', snapshot: { projectId: 'p1', state: 'stopped', restarted: false }, logs: [],
    }
    render(<ProjectRunManager api={api(noPort).api as never} projectId="p1" projectName="demo" onRevealBrowser={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('Python server.py')).toBeTruthy()
    expect((screen.getByLabelText('連接埠') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('button', { name: '保存並執行' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('連接埠由另一個專案管理時顯示該專案名稱', async () => {
    const conflicted: ProjectRunResponse = {
      ...state,
      snapshot: {
        ...state.snapshot, state: 'failed',
        conflict: { pid: 8123, processName: 'node server.js', projectName: 'Owner Project' },
      },
    }
    render(<ProjectRunManager api={api(conflicted).api as never} projectId="p1" projectName="demo" onRevealBrowser={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('連接埠由 專案「Owner Project」 使用（PID 8123）')).toBeTruthy()
  })
})
