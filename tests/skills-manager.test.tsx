// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillsManager } from '../src/renderer/components/SkillsManager.js'
import type { SkillsRequest, SkillsResponse, SkillInspection, SkillsState } from '../src/shared/skills.js'

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(cleanup)
const id = '10000000-0000-4000-8000-000000000001'
const inspection: SkillInspection = { id, url: 'https://github.com/a/b', ref: 'HEAD', commit: 'a'.repeat(40), warnings: [],
  candidates: [{ path: 'skills/design', name: 'design', description: 'Design interfaces', markdown: '---\nname: design\n---\n<script>bad()</script>' }] }
const installed: SkillsState = { revision: id, skills: [{ id, name: 'design', description: 'Design interfaces', source: { url: inspection.url, ref: 'HEAD', path: 'skills/design' }, commit: inspection.commit, enabled: true, installedAt: '2026-09-21' }] }
const empty: SkillsResponse = { kind: 'state', state: { revision: null, skills: [] } }

it('inspects without installing, requires selection, and shows installed source/version after completion', async () => {
  const manageSkills = vi.fn(async (request: SkillsRequest): Promise<SkillsResponse> => request.action === 'inspect' ? { kind: 'inspection', inspection } : request.action === 'install' ? { kind: 'state', state: installed } : empty)
  const { container } = render(<SkillsManager api={{ manageSkills }} onClose={() => {}} />)
  await screen.findByText('共用庫還沒有 skills。貼上 GitHub 網址開始加入。')
  expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
  expect(screen.getByText('安裝一次，所有專案的 Codex 與 Claude 都能使用。')).toBeTruthy()
  expect(screen.queryByText('YESCHEF · 共用能力')).toBeNull()
  fireEvent.change(screen.getByLabelText('公開 repository 網址'), { target: { value: inspection.url } })
  fireEvent.click(screen.getByRole('button', { name: '讀取 Skills' }))
  await screen.findByText('Design interfaces')
  expect(manageSkills.mock.calls.some(([request]) => request.action === 'install')).toBe(false)
  expect((screen.getByRole('button', { name: '安裝／更新選取項目' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '安裝／更新選取項目' }))
  await screen.findByText('安裝完成，所有專案的新對話可使用')
  expect(screen.getByText('已啟用 · 新對話可用')).not.toBeNull()
  expect(manageSkills).toHaveBeenCalledWith({ action: 'install', inspectionId: id, paths: ['skills/design'] })
})

it('shows network failure, retains URL and permits retry', async () => {
  let attempt = 0
  const manageSkills = vi.fn(async (request: SkillsRequest): Promise<SkillsResponse> => {
    if (request.action !== 'inspect') return empty
    if (++attempt === 1) throw Error('offline')
    return { kind: 'inspection', inspection }
  })
  render(<SkillsManager api={{ manageSkills }} onClose={() => {}} />)
  await screen.findByText('共用庫還沒有 skills。貼上 GitHub 網址開始加入。')
  fireEvent.change(screen.getByLabelText('公開 repository 網址'), { target: { value: inspection.url } })
  fireEvent.click(screen.getByRole('button', { name: '讀取 Skills' }))
  expect((await screen.findByRole('alert')).textContent).toBe('offline')
  fireEvent.click(screen.getByRole('button', { name: '讀取 Skills' }))
  await screen.findByText('Design interfaces')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('supports enable, checks update without replacing files, and requires explicit remove confirmation', async () => {
  const manageSkills = vi.fn(async (request: SkillsRequest): Promise<SkillsResponse> => request.action === 'inspect' ? { kind: 'inspection', inspection }
    : request.action === 'remove' ? empty : { kind: 'state', state: request.action === 'enable' ? { ...installed, skills: [{ ...installed.skills[0]!, enabled: request.enabled }] } : installed })
  render(<SkillsManager api={{ manageSkills }} onClose={() => {}} />)
  await screen.findByText('Design interfaces')
  await waitFor(() => expect((screen.getByRole('button', { name: '檢查更新' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('啟用 design'))
  await screen.findByText('已停用')
  fireEvent.click(screen.getByRole('button', { name: '檢查更新' }))
  await screen.findByText('design 已是最新版本')
  fireEvent.click(screen.getByRole('button', { name: /^移除$/ }))
  expect(manageSkills.mock.calls.some(([request]) => request.action === 'remove')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '確認移除' }))
  await screen.findByText('已移除，進行中的對話維持原版本')
})

it('shows immediate toggle feedback, then restores the original state on failure', async () => {
  let finish: ((value: SkillsResponse) => void) | undefined
  const manageSkills = vi.fn(async (request: SkillsRequest): Promise<SkillsResponse> => request.action === 'enable'
    ? new Promise(resolve => { finish = resolve }) : { kind: 'state', state: installed })
  render(<SkillsManager api={{ manageSkills }} onClose={() => {}} />)
  await screen.findByText('Design interfaces')
  await waitFor(() => expect((screen.getByLabelText('啟用 design') as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByLabelText('啟用 design'))
  expect((screen.getByLabelText('啟用 design') as HTMLInputElement).checked).toBe(false)
  finish?.({ kind: 'error', message: 'Disk unavailable' })
  await screen.findByText('Disk unavailable')
  expect((screen.getByLabelText('啟用 design') as HTMLInputElement).checked).toBe(true)
})
