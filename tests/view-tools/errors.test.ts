import { describe, expect, it } from 'vitest'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'

describe('ViewToolError', () => {
  it('name 固定為 ViewToolError，訊息原樣保留', () => {
    const err = new ViewToolError('右窗格不存在')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ViewToolError')
    expect(err.message).toBe('右窗格不存在')
  })
})

describe('MSG（契約 §10.1，逐字比對）', () => {
  it('codex 殼新增的三條', () => {
    expect(MSG.badArgs('view_click', 'ref')).toBe('view_click 的參數不合規：ref')
    expect(MSG.unknownTool('view_xxx')).toBe('不認得的工具 view_xxx')
    expect(MSG.approvalDenied).toBe('使用者拒絕')
  })

  it('固定字串', () => {
    expect(MSG.viewGone).toBe('右窗格不存在')
    expect(MSG.badScheme).toBe('只接受 http、https、file 開頭的網址')
    expect(MSG.refFormat).toBe('ref 格式應為 s<數字>-e<數字>')
    expect(MSG.handoffNoId).toBe('找不到這次交接的 toolUseId，請重試')
    expect(MSG.sessionEnded).toBe('對話已結束')
  })

  it('invalidUrl', () => {
    expect(MSG.invalidUrl('not a url')).toBe('網址無法解析：not a url')
  })

  it('outsideProject', () => {
    expect(MSG.outsideProject('/Users/x/project')).toBe('只允許開啟 /Users/x/project 底下的本地檔案')
  })

  it('navigateFailed', () => {
    expect(MSG.navigateFailed('https://a.test/', '連線逾時')).toBe('無法開啟 https://a.test/：連線逾時')
  })

  it('navigateTimeout', () => {
    expect(MSG.navigateTimeout('https://a.test/')).toBe('頁面在 8 秒內未載入完成，目前網址 https://a.test/')
  })

  it('settleTimeout', () => {
    expect(MSG.settleTimeout(5)).toBe('頁面在 5 秒內未靜默，請 snapshot 確認狀態')
  })

  it('refStale：documentUpdated／navigated／userInput 照原字', () => {
    expect(MSG.refStale(12, 'documentUpdated')).toBe('snapshot s12 已過期（原因：documentUpdated），請先呼叫 view_snapshot')
    expect(MSG.refStale(12, 'navigated')).toBe('snapshot s12 已過期（原因：navigated），請先呼叫 view_snapshot')
    expect(MSG.refStale(12, 'userInput')).toBe('snapshot s12 已過期（原因：userInput），請先呼叫 view_snapshot')
  })

  it('refStale：newer-snapshot 改寫成「已有更新的 snapshot」', () => {
    expect(MSG.refStale(12, 'newer-snapshot')).toBe('snapshot s12 已過期（原因：已有更新的 snapshot），請先呼叫 view_snapshot')
  })

  it('refMissing：取 ref 裡 e 那半段，不是整個 ref', () => {
    expect(MSG.refMissing(3, 's3-e5')).toBe('snapshot s3 沒有 e5 這個節點')
  })

  it('refDetached', () => {
    expect(MSG.refDetached('s3-e5')).toBe('ref s3-e5 指向的元素已不在頁面上，請重新 snapshot')
  })

  it('badKey', () => {
    expect(MSG.badKey('F1', ['Enter', 'Tab'])).toBe('不支援的按鍵 F1，可用：Enter、Tab')
  })

  it('handoffBusy', () => {
    expect(MSG.handoffBusy('填完表單')).toBe('已有一筆交接等待中（填完表單），請等使用者完成')
  })

  it('handoffDone／handoffTimeout', () => {
    expect(MSG.handoffDone('https://a.test/')).toBe('使用者已完成，目前網址 https://a.test/')
    expect(MSG.handoffTimeout('https://a.test/')).toBe('已逾時 10 分鐘，使用者未按確認，目前網址 https://a.test/')
  })

  it('cdpFailed／internal', () => {
    expect(MSG.cdpTimeout('DOM.getBoxModel', 10000)).toBe('DOM.getBoxModel 逾時（10000 毫秒）')
    expect(MSG.cdpFailed('timeout', '逾時')).toBe('CDP 指令失敗（timeout）：逾時')
    expect(MSG.internal('boom')).toBe('工具內部錯誤：boom')
    expect(MSG.evalException).toBe('頁面執行發生錯誤，但沒有提供錯誤詳情')
  })

  it('navigated／clicked／urlChanged／typed／pressed', () => {
    expect(MSG.navigated('https://a.test/', '標題')).toBe('已到 https://a.test/，標題 標題')
    expect(MSG.clicked('button', '送出')).toBe('已點擊 button "送出"')
    expect(MSG.urlChanged('https://a.test/')).toBe('網址變為 https://a.test/')
    expect(MSG.typed(3, 'textbox', '電子郵件')).toBe('已輸入 3 字元到 textbox "電子郵件"')
    expect(MSG.pressed('Enter')).toBe('已按 Enter')
  })

  it('screenshot：寬高之間是全形乘號 ×，不是英文字母 x', () => {
    expect(MSG.screenshot(1280, 720, 'https://a.test/')).toBe('可視範圍 1280×720，網址 https://a.test/')
  })

  it('evalTruncated', () => {
    expect(MSG.evalTruncated(9000)).toBe('（已截斷，原長 9000 字元）')
  })

  it('machineUnknown／machineNoPassword／machinePasswordUnreadable', () => {
    expect(MSG.machineUnknown('staging')).toBe('沒有叫 staging 的測試機，請到專案的測試機設定新增')
    expect(MSG.machineNoPassword('prod')).toBe('測試機 prod 沒有設定密碼')
    expect(MSG.machinePasswordUnreadable('prod')).toBe('測試機 prod 的密碼解不開，請到測試機設定重新輸入密碼')
  })

  it('originMismatch', () => {
    expect(MSG.originMismatch('https://example.com')).toBe('目前頁面不是 https://example.com，不會填入帳密')
  })

  it('loginRefInFrame／keychainUnavailable', () => {
    expect(MSG.loginRefInFrame).toBe('帳密欄位必須在主框架，不能在跨站 iframe 裡')
    expect(MSG.keychainUnavailable).toBe('這台電腦的鑰匙圈不可用，無法儲存密碼')
  })

  it('loginNotPasswordField／loginNotUsernameField／loginNotSubmitButton', () => {
    expect(MSG.loginNotPasswordField('s1-e1')).toBe('s1-e1 不是密碼欄位（input type=password），不會填入密碼')
    expect(MSG.loginNotUsernameField('s1-e0')).toBe('s1-e0 不是文字輸入欄位，不會填入帳號')
    expect(MSG.loginNotSubmitButton('s1-e2')).toBe('s1-e2 不是按鈕，不會用它送出')
  })

  it('loggedIn／loginClearFailed', () => {
    expect(MSG.loggedIn('qa-user', 'https://staging.test/')).toBe('已用 qa-user 的帳密送出登入，目前網址 https://staging.test/')
    expect(MSG.loginClearFailed).toBe('密碼欄可能沒有清空，請勿在這個頁面上呼叫 view_eval 讀取欄位內容，並回報使用者')
  })
})
