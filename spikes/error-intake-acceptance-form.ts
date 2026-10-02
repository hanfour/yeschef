import type { RuntimeContext } from './group-acceptance-runtime.js'
import { readTasks } from './group-acceptance-state.js'
import type { AcceptanceConfig } from './error-intake-acceptance-runtime.js'
import { clickButton, requirePage, waitForNewChefTask, waitForValue } from './error-intake-acceptance-ui.js'

export async function setupDatabaseAndEnable(context: RuntimeContext, config: AcceptanceConfig): Promise<readonly string[]> {
  const page = requirePage(context)
  await clickButton(page, '錯誤收集')
  await waitForValue(page, '設定對話框', `document.querySelector('#error-intake-title')?.textContent?.trim() === '錯誤收集資料庫'`)
  await fillDatabaseSettings(page, config)
  await initializeDatabase(page)
  await enableDemoApp(context, page)
  return await createChefTask(context, page)
}

async function fillDatabaseSettings(page: Awaited<ReturnType<typeof requirePage>>, config: AcceptanceConfig): Promise<void> {
  const failed = await page.evaluate<string[]>(`(() => {
    const values = ${JSON.stringify({
      主機: config.database.host,
      連接埠: String(config.database.port),
      資料庫: 'error_intake_test',
      管理者帳號: config.database.user,
      管理者密碼: config.database.password,
      套件來源: config.packageSource,
    })};
    const failures = [];
    for (const [name, value] of Object.entries(values)) {
      const label = Array.from(document.querySelectorAll('label')).find(node => node.textContent?.trim().startsWith(name));
      const input = label?.querySelector('input');
      if (!(input instanceof HTMLInputElement)) { failures.push(name); continue; }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.value !== value) failures.push(name);
    }
    const tls = Array.from(document.querySelectorAll('label')).find(node => node.textContent?.trim().startsWith('TLS'))?.querySelector('input');
    if (!(tls instanceof HTMLInputElement)) failures.push('TLS');
    // React 的勾選框靠 click 觸發 onChange；直接改 checked 再送 change，畫面變了但狀態沒變。
    else {
      if (tls.checked) tls.click();
      if (tls.checked) failures.push('TLS');
    }
    return failures;
  })()`)
  if (failed.length > 0) throw new Error(`錯誤收集設定欄位不可用：${failed.join(',')}`)
  await clickButton(page, '儲存')
}

async function initializeDatabase(page: Awaited<ReturnType<typeof requirePage>>): Promise<void> {
  await clickButton(page, '連線並初始化')
  const ready = await (async () => {
    try {
      return await waitForValue(page, 'Schema 版本 1', `(() => {
    const rows = Array.from(document.querySelectorAll('.error-intake-status > div'));
    return rows.some(row => row.textContent?.includes('資料庫連線') && row.querySelector('strong')?.textContent?.trim() === '可連線') &&
      rows.some(row => row.textContent?.includes('Schema 版本') && row.querySelector('strong')?.textContent?.trim() === '1');
  })()`)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}；對話框訊息：${await dialogError(page)}`)
    }
  })()
  if (!ready) throw new Error(`錯誤資料庫未顯示可連線且 schema 版本 1：${await dialogError(page)}`)
}

/** 對話框上顯示的錯誤訊息（role=alert），逾時時一併記錄，不用再猜原因。 */
async function dialogError(page: Awaited<ReturnType<typeof requirePage>>): Promise<string> {
  return await page.evaluate<string>(`document.querySelector('.error-intake-error')?.textContent?.trim() ?? '對話框沒有錯誤訊息'`)
}

async function enableDemoApp(context: RuntimeContext, page: Awaited<ReturnType<typeof requirePage>>): Promise<void> {
  // 初始化後「目前專案」區塊會重讀狀態，期間欄位暫時不在畫面上；先等它們出現再操作。
  await waitForValue(page, '目前專案的代號與確認欄位', `(() => document.querySelector('.error-intake-project-code input') instanceof HTMLInputElement && document.querySelector('.error-intake-consent input') instanceof HTMLInputElement)()`)
  const projectName = await page.evaluate<string | null>(`document.querySelector('.error-intake-project-name')?.textContent?.trim() ?? null`)
  if (projectName !== 'demo-app') throw new Error(`目前專案不是 demo-app (name=${projectName ?? 'missing'})`)
  await page.evaluate(`(() => {
    const code = document.querySelector('.error-intake-project-code input');
    if (code instanceof HTMLInputElement && !code.disabled && code.value !== 'demo-app') {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(code, 'demo-app');
      code.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const consent = document.querySelector('.error-intake-consent input');
    if (consent instanceof HTMLInputElement && !consent.checked) consent.click();
  })()`)
  try {
    await waitForValue(page, 'demo-app 代號與送往模型供應商的確認', `(() => {
      const code = document.querySelector('.error-intake-project-code input');
      const consent = document.querySelector('.error-intake-consent input');
      return code instanceof HTMLInputElement && consent instanceof HTMLInputElement && code.value === 'demo-app' && consent.checked;
    })()`)
  } catch (error) {
    throw new Error(`無法設定 demo-app 代號與資料送往模型供應商確認：${error instanceof Error ? error.message : String(error)}；對話框訊息：${await dialogError(page)}`)
  }
  void context
}

async function createChefTask(context: RuntimeContext, page: Awaited<ReturnType<typeof requirePage>>): Promise<readonly string[]> {
  const previous = await readTasks(context)
  const priorTaskIds = previous.map((task) => task.id)
  await clickButton(page, '啟用錯誤收集')
  if (await waitForNewChefTask(context, priorTaskIds) === undefined) throw new Error('啟用後未建立錯誤收集主廚任務')
  return priorTaskIds
}
