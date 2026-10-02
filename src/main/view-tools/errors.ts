/**
 * 錯誤型別與訊息表（契約 §10.1）。`MSG` 的每一句都是給模型看的繁體中文，
 * server.ts 直接把它當 `isError: true` 的內容回傳，不再包裝或翻譯。
 */

/** 訊息已是給模型看的繁體中文，server.ts 直接回 isError 文字，不再包裝。 */
export class ViewToolError extends Error {
  readonly name = 'ViewToolError'
}

/**
 * `refStale` 的 reason 字串：`documentUpdated`／`navigated`／`userInput` 照原字，
 * `newer-snapshot`（ref 與目前 RefTable 的 snapshotId 不相等，常見情況是 ref 比目前表舊）改寫成
 * 「已有更新的 snapshot」（契約 §10.1 段末的規則）。呼叫端不必自己轉換，直接把
 * `RefLookup` 的 `reason` 傳進 `MSG.refStale` 即可。
 */
function renderStaleReason(reason: string): string {
  return reason === 'newer-snapshot' ? '已有更新的 snapshot' : reason
}

export const MSG = {
  viewGone: '右窗格不存在',
  badScheme: '只接受 http、https、file 開頭的網址',
  noActiveProject: '目前沒有 active 專案',
  invalidUrl: (raw: string) => `網址無法解析：${raw}`,
  outsideProject: (projectDir: string) => `只允許開啟 ${projectDir} 底下的本地檔案`,
  navigateFailed: (url: string, errorText: string) => `無法開啟 ${url}：${errorText}`,
  navigateTimeout: (url: string) => `頁面在 8 秒內未載入完成，目前網址 ${url}`,
  settleTimeout: (seconds: number) => `頁面在 ${seconds} 秒內未靜默，請 snapshot 確認狀態`,
  refFormat: 'ref 格式應為 s<數字>-e<數字>',
  refStale: (snapshotId: number, reason: string) =>
    `snapshot s${snapshotId} 已過期（原因：${renderStaleReason(reason)}），請先呼叫 view_snapshot`,
  refMissing: (snapshotId: number, ref: string) => `snapshot s${snapshotId} 沒有 ${ref.split('-')[1]} 這個節點`,
  refDetached: (ref: string) => `ref ${ref} 指向的元素已不在頁面上，請重新 snapshot`,
  badKey: (key: string, names: readonly string[]) => `不支援的按鍵 ${key}，可用：${names.join('、')}`,
  handoffBusy: (reason: string) => `已有一筆交接等待中（${reason}），請等使用者完成`,
  handoffNoId: '找不到這次交接的 toolUseId，請重試',
  handoffDone: (url: string) => `使用者已完成，目前網址 ${url}`,
  handoffTimeout: (url: string) => `已逾時 10 分鐘，使用者未按確認，目前網址 ${url}`,
  sessionEnded: '對話已結束',
  inputNotLive: '輸入到達時 session 已不在 live，這則輸入未送出',
  inputSessionChanged: (text: string) => `這則輸入未送出（session 已切換）：${text}`,
  browserUnavailable: '這個對話的瀏覽器無法啟動，請再試一次',
  notUrl: '這不是網址',
  cdpTimeout: (method: string, milliseconds: number) => `${method} 逾時（${milliseconds} 毫秒）`,
  cdpFailed: (code: string, message: string) => `CDP 指令失敗（${code}）：${message}`,
  internal: (message: string) => `工具內部錯誤：${message}`,
  badCommand: '指令格式不對',
  machineUnknown: (name: string) => `沒有叫 ${name} 的測試機，請到專案的測試機設定新增`,
  machineNoPassword: (name: string) => `測試機 ${name} 沒有設定密碼`,
  machinePasswordUnreadable: (name: string) => `測試機 ${name} 的密碼解不開，請到測試機設定重新輸入密碼`,
  originMismatch: (origin: string) => `目前頁面不是 ${origin}，不會填入帳密`,
  loginRefInFrame: '帳密欄位必須在主框架，不能在跨站 iframe 裡',
  loginNotPasswordField: (ref: string) => `${ref} 不是密碼欄位（input type=password），不會填入密碼`,
  loginNotUsernameField: (ref: string) => `${ref} 不是文字輸入欄位，不會填入帳號`,
  loginNotSubmitButton: (ref: string) => `${ref} 不是按鈕，不會用它送出`,
  keychainUnavailable: '這台電腦的鑰匙圈不可用，無法儲存密碼',
  loggedIn: (machine: string, url: string) => `已用 ${machine} 的帳密送出登入，目前網址 ${url}`,
  loginClearFailed: '密碼欄可能沒有清空，請勿在這個頁面上呼叫 view_eval 讀取欄位內容，並回報使用者',
  badArgs: (tool: string, fields: string) => `${tool} 的參數不合規：${fields}`,
  unknownTool: (name: string) => `不認得的工具 ${name}`,
  approvalDenied: '使用者拒絕',
  evalException: '頁面執行發生錯誤，但沒有提供錯誤詳情',
  navigated: (url: string, title: string) => `已到 ${url}，標題 ${title}`,
  clicked: (role: string, name: string) => `已點擊 ${role} "${name}"`,
  urlChanged: (url: string) => `網址變為 ${url}`,
  typed: (count: number, role: string, name: string) => `已輸入 ${count} 字元到 ${role} "${name}"`,
  pressed: (key: string) => `已按 ${key}`,
  screenshot: (width: number, height: number, url: string) => `可視範圍 ${width}×${height}，網址 ${url}`,
  evalTruncated: (length: number) => `（已截斷，原長 ${length} 字元）`,
} as const
