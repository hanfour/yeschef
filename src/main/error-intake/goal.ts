import { extname, isAbsolute } from 'node:path'
import { ERROR_INTAKE_PACKAGE_SOURCE } from '../../shared/error-intake.js'

export function defaultProjectCode(folderName: string): string {
  const code = folderName.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '')
  return code || 'project'
}

export function validatePackageSource(source: string): string {
  if (source === ERROR_INTAKE_PACKAGE_SOURCE) return source
  if (/[\r\n]/.test(source) || !isAbsolute(source) || extname(source) !== '.tgz') {
    throw new Error('套件來源須為 @yeschef/error-intake 或本機 .tgz 絕對路徑')
  }
  return source
}

export function errorIntakeSetupGoal(projectCode: string, packageSource: string): string {
  const installSource = packageSource === ERROR_INTAKE_PACKAGE_SOURCE ? packageSource : shellQuote(packageSource)
  return `在這個專案安裝並設定錯誤收集，完成後開一個 draft PR。
專案代號：${projectCode}
步驟：
1. 判斷專案的技術堆疊：NestJS、Express、Next.js，以及前端框架。不屬於這幾種時停下並在報告說明。
2. 在後端執行 npm install ${installSource}，依套件 README 對應的接法接上：伺服器端例外處理、瀏覽器回報的接收端點、瀏覽器端回報。README 位於 node_modules/@yeschef/error-intake/README.md。
3. 程式只讀環境變數 ERROR_INTAKE_DATABASE_URL、ERROR_INTAKE_PROJECT、APP_ENV，不寫入任何實際值。
4. 用 configure_error_intake_env 工具，指定本機開發用、已被 .gitignore 排除的環境變數檔，讓 YesChef 寫入實際值。
5. 寫測試：觸發一個伺服器錯誤與一個瀏覽器錯誤，確認送到套件的 sink（測試中用假的 sink）。
6. 啟動本機服務，實際觸發一個錯誤，用 check_error_intake 工具確認資料庫收到這個專案的錯誤。驗證完立刻停掉這次啟動的服務（停止方式見工作指示），並在報告寫明已停止。沒有停掉的背景工作會讓任務被判定需要核對。
7. 跑專案既有的 typecheck、lint、測試。
8. 用 gh pr create --draft 開 PR，內文列出 staging 與正式環境要設定的環境變數名稱（不含值）。
不讀取、不輸出 .env 內容，不 merge，不 push 到 main。`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
