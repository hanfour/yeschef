import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDevelopmentDiff } from '../src/main/development-diff.js'
// These integration cases spawn real Git processes; allow for contention in the full suite.
vi.setConfig({ testTimeout: 20000 })
const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-diff-test-')); roots.push(root)
  const repo = join(root, 'repo'); await mkdir(repo)
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout
  await git('init'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid'); await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'file.txt'), 'initial\n'); await git('add', '.'); await git('commit', '-m', 'base')
  return { root, repo, git, service: createDevelopmentDiff(join(root, 'baselines')) }
}
it('對話基準排除開始前的 dirty 內容，涵蓋後續已 commit 與未提交變更，且不改 index', async () => {
  const r = await rig(); await writeFile(join(r.repo, 'file.txt'), 'preexisting\n'); await r.git('add', '.')
  await writeFile(join(r.repo, 'untracked.txt'), 'before\n')
  const index = await readFile(join(r.repo, '.git/index'))
  await r.service.capture('conversation', r.repo)
  expect(await readFile(join(r.repo, '.git/index'))).toEqual(index)
  expect((await r.service.read('conversation', r.repo, 'conversation')).files).toEqual([])
  await writeFile(join(r.repo, 'file.txt'), 'developed\n'); await r.git('add', '.'); await r.git('commit', '-m', 'development')
  await writeFile(join(r.repo, 'untracked.txt'), 'after\n'); await writeFile(join(r.repo, 'empty.txt'), '')
  const changes = await r.service.read('conversation', r.repo, 'conversation')
  expect(changes.files.find(f => f.path === 'file.txt')?.patch).toContain('-preexisting')
  expect(changes.files.find(f => f.path === 'file.txt')?.patch).toContain('+developed')
  expect(changes.files.find(f => f.path === 'untracked.txt')?.patch).toContain('-before')
  expect(changes.files.find(f => f.path === 'empty.txt')).toMatchObject({ status: 'added', patch: '新增空檔案' })
  const working = await r.service.read('conversation', r.repo, 'working')
  expect(working.files.some(f => f.path === 'file.txt')).toBe(false)
  const reload = createDevelopmentDiff(join(r.root, 'baselines'))
  expect((await reload.read('conversation', r.repo, 'conversation')).files).toEqual(changes.files)
})

it('changedFiles 只回傳基準後新增或修改的介面副檔名', async () => {
  const r = await rig(), key = 'chef:ui-check'
  await writeFile(join(r.repo, 'kept.css'), '.kept { color: red; }\n')
  await writeFile(join(r.repo, 'removed.scss'), '.removed { color: red; }\n')
  await r.service.capture(key, r.repo)
  await writeFile(join(r.repo, 'kept.css'), '.kept { color: blue; }\n')
  await writeFile(join(r.repo, 'new.tsx'), '<div className="card" />\n')
  await r.git('add', 'new.tsx'); await r.git('commit', '-m', 'add component')
  await writeFile(join(r.repo, 'notes.md'), 'not scanned\n')
  await rm(join(r.repo, 'removed.scss'))

  expect(await r.service.changedFiles(key, r.repo)).toEqual([
    { path: 'kept.css', text: '.kept { color: blue; }\n' },
    { path: 'new.tsx', text: '<div className="card" />\n' },
  ])
})
it('尚無基準顯示明確錯誤，但仍能查看未提交檔案；二進位不假裝文字', async () => {
  const r = await rig(); await writeFile(join(r.repo, 'photo.png'), Buffer.from([0,1,2,3]))
  await expect(r.service.read('missing', r.repo, 'conversation')).rejects.toThrow('尚無開發基準')
  expect((await r.service.read('missing', r.repo, 'working')).files).toEqual([expect.objectContaining({ path: 'photo.png', binary: true })])
})
it('tracked 目錄被換成外部符號連結，不讀取外部內容', async () => {
  const r = await rig(); await mkdir(join(r.repo, 'dir')); await writeFile(join(r.repo, 'dir/a'), 'base'); await r.git('add', '.'); await r.git('commit', '-m', 'nested')
  await r.service.capture('c', r.repo)
  const outside = join(r.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'a'), 'sensitive-outside-value')
  await rm(join(r.repo, 'dir'), { recursive: true }); await symlink(outside, join(r.repo, 'dir'))
  const result = await r.service.read('c', r.repo, 'conversation')
  expect(JSON.stringify(result)).not.toContain('sensitive-outside-value')
  expect(result.files.find(f => f.path === 'dir/a')?.omitted).toBe(true)
})

it('父層工作台分別記錄各子 repo 的初始 dirty，後續 commit 仍能各自查看', async () => {
  const r = await rig()
  const second = join(r.root, 'service-b'); await mkdir(second)
  const git = async (...args: string[]) => (await exec('git', args, { cwd: second })).stdout
  await git('init'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid'); await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(second, 'backend.txt'), 'original\n'); await git('add', '.'); await git('commit', '-m', 'base')
  await writeFile(join(r.repo, 'file.txt'), 'already dirty\n')
  const catalog = await r.service.repositories(r.root, [join(r.repo, 'file.txt'), join(r.root, 'service-b/backend.txt')])
  expect(catalog.repositories.map(p => p.label)).toEqual(['repo', 'service-b'])
  const firstId = catalog.repositories.find(p => p.label === 'repo')!.id
  const secondId = catalog.repositories.find(p => p.label === 'service-b')!.id
  await r.service.capture('parent-thread', r.root)
  await writeFile(join(r.repo, 'file.txt'), 'new frontend\n'); await r.git('add', '.'); await r.git('commit', '-m', 'frontend')
  await writeFile(join(second, 'backend.txt'), 'new backend\n')
  const first = await r.service.read('parent-thread', r.root, 'conversation', firstId)
  expect(first.files).toHaveLength(1); expect(first.files[0]?.patch).toContain('-already dirty')
  const other = await r.service.read('parent-thread', r.root, 'conversation', secondId)
  expect(other.files[0]?.path).toBe('backend.txt'); expect(other.files[0]?.patch).toContain('+new backend')
  await expect(r.service.read('parent-thread', r.root, 'working')).rejects.toThrow('先選擇')
  await expect(r.service.read('parent-thread', r.root, 'working', '/outside/repo')).rejects.toThrow('範圍')
})

it('沒有歷史基準也能指定 commit 比較已提交變更，無效 ref 不會執行額外參數', async () => {
  const r = await rig(); const base = (await r.git('rev-parse', 'HEAD')).trim()
  await writeFile(join(r.repo, 'file.txt'), 'committed change\n'); await r.git('add', '.'); await r.git('commit', '-m', 'change')
  expect((await r.service.read('old', r.repo, 'working')).files).toEqual([])
  const result = await r.service.read('old', r.repo, 'base', undefined, base)
  expect(result.files[0]?.patch).toContain('+committed change')
  await expect(r.service.read('old', r.repo, 'base', undefined, '--output=attack')).rejects.toThrow('找不到')
})

it('不跟隨 repo symlink，支援 .git 檔案型 worktree，晚出現 repo 不偽造對話基準', async () => {
  const r = await rig()
  await symlink(r.repo, join(r.root, 'linked'))
  const worktree = join(r.root, 'worktree'); await r.git('worktree', 'add', '--detach', worktree, 'HEAD')
  const catalog = await r.service.repositories(r.root, [join(r.repo, 'file.txt'), join(worktree, 'file.txt')])
  expect(catalog.repositories.map(p => p.label)).toEqual(['repo', 'worktree'])
  await r.service.capture('parent', r.root)
  const late = join(r.root, 'late'); await mkdir(late); await exec('git', ['init'], { cwd: late })
  const added = (await r.service.repositories(r.root, [join(late, 'new.txt')])).repositories.find(p => p.label === 'late')!
  await r.service.capture('parent', r.root)
  await expect(r.service.read('parent', r.root, 'conversation', added.id)).rejects.toThrow('建立後才被找到')
})

it('大量初始圖片以 fingerprint 保存，不排擠文字檔基準且不誤報未變圖片', async () => {
  const r = await rig()
  for (let i = 0; i < 10; i++) await writeFile(join(r.repo, `image-${i}.png`), Buffer.alloc(450000, i))
  await writeFile(join(r.repo, 'z-code.ts'), 'before\n')
  // Each image is binary (including a NUL), even when most of its bytes are nonzero.
  for (let i = 1; i < 10; i++) { const b = Buffer.alloc(450000, i); b[0] = 0; await writeFile(join(r.repo, `image-${i}.png`), b) }
  await r.service.capture('images', r.repo)
  expect((await r.service.read('images', r.repo, 'conversation')).files).toEqual([])
  await writeFile(join(r.repo, 'z-code.ts'), 'after\n')
  await writeFile(join(r.repo, 'image-0.png'), Buffer.from([0, 1, 2]))
  const result = await r.service.read('images', r.repo, 'conversation')
  expect(result.files).toHaveLength(2)
  expect(result.files.find(f => f.path === 'image-0.png')).toMatchObject({ status: 'modified', binary: true })
  expect(result.files.find(f => f.path === 'z-code.ts')?.patch).toContain('-before')
})

it('repo 清單只含有此對話寫檔證據的 repo，其他 dirty repo 不混入', async () => {
  const r = await rig()
  const other = join(r.root, 'other'); await mkdir(other); await exec('git', ['init'], { cwd: other }); await writeFile(join(other, 'dirty.txt'), 'unrelated')
  expect((await r.service.repositories(r.root)).repositories).toEqual([])
  const catalog = await r.service.repositories(r.root, [join(r.repo, 'file.txt'), join(r.root, 'outside.txt')])
  expect(catalog.repositories.map(p => p.label)).toEqual(['repo'])
  const otherId = (await r.service.repositories(r.root, [join(other, 'dirty.txt')])).repositories[0]!.id
  await expect(r.service.read('key', r.root, 'working', otherId, undefined, [join(r.repo, 'file.txt')])).rejects.toThrow('沒有本次對話')
})
