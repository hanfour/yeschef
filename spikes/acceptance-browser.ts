/**
 * 用真的 Electron 跑兩份規格裡不需要看畫面就能驗的項目:
 * - 測試機規格 §8.2 #2 #3 #4 #5(登入、密碼欄清空、snapshot 不含密碼、origin 不符不填)加 C1(非密碼欄位被擋)
 * - 每對話瀏覽器規格 §9.2 #2 #6(cookie 隔離、關閉後 renderer 行程消失)
 * 每項印一行 JSON:{ check, ok, detail }。全部通過 exit 0,否則 exit 1。
 * 打包方式同 spike:sessions(esbuild → cjs → electron),所以用 __dirname。
 */
import { app, BaseWindow, type WebContentsView } from 'electron'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
declare const __dirname: string
import { agentPartitionFor, createAgentView } from '../src/main/agent-view.js'
import { SYSTEM_CLOCK } from '../src/main/agent-host.js'
import { attachCdp, type CdpSession } from '../src/main/cdp.js'
import { MSG } from '../src/main/view-tools/errors.js'
import { createViewToolServer, type ViewTools } from '../src/main/view-tools/server.js'
import type { Credentials } from '../src/main/view-tools/controller-types.js'

const PASSWORD = 'Sp1ke-s3cret!'
const USERNAME = 'qa'
const FIXTURE = readFileSync(join(__dirname, 'fixtures/login-page.html'))
const results: { check: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ check: name, ok, detail })
  console.log(JSON.stringify({ check: name, ok, detail }))
}

function serve(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(FIXTURE) })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

interface Session { readonly view: WebContentsView; readonly cdp: CdpSession; readonly tools: ViewTools }

async function openSession(win: BaseWindow, id: string, url: string, credentials: (machine: string) => Promise<Credentials | undefined>): Promise<Session> {
  const view = createAgentView({ currentProjectDir: () => join(__dirname, 'fixtures'), logError: (e) => { console.error(e) } }, agentPartitionFor(id))
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
  await view.webContents.loadURL(url)
  const cdp = await attachCdp(view.webContents, { onListenerError: (e) => { console.error(e) } })
  const tools = await createViewToolServer({
    view, cdp, clock: SYSTEM_CLOCK, projectDir: () => join(__dirname, 'fixtures'), credentials,
    logError: (e) => { console.error('[logError]', e.message) },
  })
  return { view, cdp, tools }
}

async function evaluate<T>(cdp: CdpSession, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true })
  return r.result.value
}

async function invoke(tools: ViewTools, name: string, args: object): Promise<{ ok: boolean; text: string; image?: string }> {
  const r = await tools.invoke(name, args, { callId: `${name}-${Date.now()}` })
  if (!r.ok) return { ok: false, text: r.text }
  return r.output.kind === 'image' ? { ok: true, text: r.output.text, image: r.output.dataBase64 } : { ok: true, text: r.output.text }
}

/** 從 snapshot 文字裡依名稱找 ref。 */
function refOf(snapshot: string, name: string): string {
  const m = new RegExp(`^(s\\d+-e\\d+) \\S+ "${name}"`, 'm').exec(snapshot)
  if (m === null) throw new Error(`snapshot 裡找不到 "${name}"。snapshot:\n${snapshot}`)
  return m[1]!
}

async function main(): Promise<void> {
  await app.whenReady()
  const a = await serve()
  const b = await serve()
  const win = new BaseWindow({ width: 800, height: 600, show: true, title: 'yeschef 驗收' })
  const staging = async (machine: string): Promise<Credentials | undefined> =>
    machine === 'staging' ? { username: USERNAME, password: PASSWORD, passwordUnreadable: false, origin: a.origin } : undefined

  const s1 = await openSession(win, 'acceptance-1', `${a.origin}/login`, staging)
  const s2 = await openSession(win, 'acceptance-2', `${a.origin}/login`, staging)

  // 每對話瀏覽器 §9.2 #2:cookie 隔離
  const cookieA = await evaluate<string>(s1.cdp, `document.cookie = 'probe=1; path=/'; document.cookie`)
  const cookieB = await evaluate<string>(s2.cdp, `document.cookie`)
  check('cookie 隔離:甲設 probe=1 後乙讀不到', cookieA.includes('probe=1') && !cookieB.includes('probe=1'), `甲=${JSON.stringify(cookieA)} 乙=${JSON.stringify(cookieB)}`)

  // 測試機 §8.2 #4(snapshot):先把密碼打進欄位,snapshot 不能含明文
  const snap0 = await invoke(s1.tools, 'view_snapshot', {})
  const pRef0 = refOf(snap0.text, '密碼')
  await invoke(s1.tools, 'view_type', { ref: pRef0, text: PASSWORD, clear: true })
  const snapWithPassword = await invoke(s1.tools, 'view_snapshot', {})
  check('snapshot 不含密碼明文(欄位裡有密碼時)', snapWithPassword.ok && !snapWithPassword.text.includes(PASSWORD), snapWithPassword.text.split('\n').find((l) => l.includes('密碼')) ?? '')
  const shot = await invoke(s1.tools, 'view_screenshot', {})
  if (shot.image !== undefined) {
    const path = join(__dirname, 'acceptance-screenshot.png')
    writeFileSync(path, Buffer.from(shot.image, 'base64'))
    check('screenshot 已存檔,請人看密碼欄是否為遮罩', true, path)
  } else {
    check('screenshot 已存檔,請人看密碼欄是否為遮罩', false, shot.text)
  }
  await evaluate(s1.cdp, `document.getElementById('password').value = ''; document.getElementById('username').value = ''`)

  // 測試機 §8.2 #2 #3:view_login 登入、密碼欄回傳前已清空
  const snap1 = await invoke(s1.tools, 'view_snapshot', {})
  const uRef = refOf(snap1.text, '帳號')
  const pRef = refOf(snap1.text, '密碼')
  const sRef = refOf(snap1.text, '登入')
  const login = await invoke(s1.tools, 'view_login', { machine: 'staging', usernameRef: uRef, passwordRef: pRef, submitRef: sRef })
  const submitted = await evaluate<{ u: string; p: string } | null>(s1.cdp, `window.__submitted`)
  const after = await evaluate<{ u: string; p: string }>(s1.cdp, `({ u: document.getElementById('username').value, p: document.getElementById('password').value })`)
  check('view_login 回 loggedIn 且不含帳密', login.ok && login.text.startsWith('已用 staging 的帳密送出登入') && !login.text.includes(PASSWORD) && !login.text.includes(USERNAME), login.text)
  check('表單真的以正確帳密送出', submitted !== null && submitted.u === USERNAME && submitted.p === PASSWORD, JSON.stringify(submitted))
  check('回傳後密碼欄是空字串(view_eval 會讀到的值)', after.p === '', `password.value=${JSON.stringify(after.p)} username.value=${JSON.stringify(after.u)}`)
  check('回傳文字沒有多出清空失敗的警告', !login.text.includes(MSG.loginClearFailed), '')

  // 沒有 submitRef 的路徑:密碼欄按 Enter
  await evaluate(s1.cdp, `window.__submitted = null; document.getElementById('password').value = ''`)
  const snap2 = await invoke(s1.tools, 'view_snapshot', {})
  const login2 = await invoke(s1.tools, 'view_login', { machine: 'staging', usernameRef: refOf(snap2.text, '帳號'), passwordRef: refOf(snap2.text, '密碼') })
  const submitted2 = await evaluate<{ u: string; p: string } | null>(s1.cdp, `window.__submitted`)
  const after2 = await evaluate<string>(s1.cdp, `document.getElementById('password').value`)
  check('沒有 submitRef:按 Enter 送出,密碼欄清空', login2.ok && submitted2 !== null && submitted2.p === PASSWORD && after2 === '', `${login2.text} submitted=${JSON.stringify(submitted2)} after=${JSON.stringify(after2)}`)

  // C1:把搜尋框當成 passwordRef
  const snap3 = await invoke(s1.tools, 'view_snapshot', {})
  const bad = await invoke(s1.tools, 'view_login', { machine: 'staging', usernameRef: refOf(snap3.text, '帳號'), passwordRef: refOf(snap3.text, '搜尋'), submitRef: refOf(snap3.text, '送出搜尋') })
  const searchState = await evaluate<{ v: string; s: string | null }>(s1.cdp, `({ v: document.getElementById('search').value, s: window.__searched })`)
  check('非密碼欄位當 passwordRef 被擋,搜尋框沒被填', !bad.ok && bad.text.includes('不是密碼欄位') && searchState.v === '' && searchState.s === null, `${bad.text} ${JSON.stringify(searchState)}`)

  // 測試機 §8.2 #5:origin 不符
  await s1.view.webContents.loadURL(`${b.origin}/login`)
  const snap4 = await invoke(s1.tools, 'view_snapshot', {})
  const mismatch = await invoke(s1.tools, 'view_login', { machine: 'staging', usernameRef: refOf(snap4.text, '帳號'), passwordRef: refOf(snap4.text, '密碼') })
  const fieldsB = await evaluate<{ u: string; p: string }>(s1.cdp, `({ u: document.getElementById('username').value, p: document.getElementById('password').value })`)
  check('origin 不符:回 originMismatch,欄位沒被填', !mismatch.ok && mismatch.text === MSG.originMismatch(a.origin) && fieldsB.u === '' && fieldsB.p === '', `${mismatch.text} ${JSON.stringify(fieldsB)}`)

  // 每對話瀏覽器 §9.2 #6:關閉後 renderer 行程消失
  const renderers = (): number => app.getAppMetrics().filter((p) => p.type === 'Tab').length
  const before = renderers()
  await s2.tools.dispose()
  s2.cdp.detach()
  win.contentView.removeChildView(s2.view)
  s2.view.webContents.close()
  await new Promise((r) => { setTimeout(r, 1500) })
  const afterClose = renderers()
  check('關掉一個 session 後 renderer 行程少一個', afterClose === before - 1, `before=${before} after=${afterClose}`)

  const failed = results.filter((r) => !r.ok).length
  console.log(JSON.stringify({ summary: { total: results.length, failed } }))
  await s1.tools.dispose()
  s1.cdp.detach()
  a.server.close()
  b.server.close()
  app.exit(failed === 0 ? 0 : 1)
}

main().catch((err: unknown) => { console.error(err); app.exit(2) })
