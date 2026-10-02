import { app, BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'

const FRONTEND_URL = 'http://localhost:5021'
const TEST_VALUES = 'jane@example.com Bearer abc.def.ghi https://x.test/p?key=leak123 0912345678'

async function main(): Promise<void> {
  const userData = process.env['EI_BROWSER_USER_DATA']
  const marker = process.env['EI_BROWSER_MARKER']
  if (userData === undefined || marker === undefined) throw new Error('BrowserWindow harness 環境缺少測試路徑')
  await mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await loadFrontend(window)
  await window.webContents.executeJavaScript(`setTimeout(() => { throw new Error(${JSON.stringify(`${marker} ${TEST_VALUES}`)}) }, 0)`)
  await wait(2_000)
  window.destroy()
  app.quit()
}

function loadFrontend(window: BrowserWindow): Promise<void> {
  return new Promise<void>((resolveLoad, rejectLoad) => {
    const timer = setTimeout(() => rejectLoad(new Error('前端載入逾時')), 30_000)
    window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolveLoad() })
    window.webContents.once('did-fail-load', (_event, code) => { clearTimeout(timer); rejectLoad(new Error(`前端載入失敗 (${code})`)) })
    void window.loadURL(FRONTEND_URL).catch(rejectLoad)
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => { setTimeout(resolveWait, ms) })
}

void main().catch(() => {
  process.exitCode = 1
  app.quit()
})
