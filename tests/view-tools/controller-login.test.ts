import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import { MSG } from '../../src/main/view-tools/errors.js'
import { invalidateRefs } from '../../src/main/view-tools/refs.js'
import type { Credentials } from '../../src/main/view-tools/controller.js'
import { createHarness, refTable, sent, tick, type Harness } from './controller-harness.js'

const STAGING: Credentials = { username: 'qa', password: 's3cret', passwordUnreadable: false, origin: 'https://staging.test' }
const ROOT_BORDER = [10, 10, 30, 10, 30, 30, 10, 30]

/** backendNodeId → DOM.describeNode 的節點描述。s1-e0 帳號(text)、s1-e1 密碼、s1-e2 送出鈕。 */
const NODES: Record<number, { nodeName: string; attributes?: string[] }> = {
  1: { nodeName: 'INPUT', attributes: ['type', 'text', 'name', 'username'] },
  2: { nodeName: 'INPUT', attributes: ['type', 'password'] },
  3: { nodeName: 'BUTTON', attributes: [] },
}

let h: Harness
let lookups: string[]

/** 帳號欄 s1-e0、密碼欄 s1-e1、送出鈕 s1-e2、跨站 iframe 裡的欄位 s1-e3。 */
async function setup(credentials: Record<string, Credentials | undefined> = { staging: STAGING }, url = 'https://staging.test/login') {
  lookups = []
  h = await createHarness('/tmp/proj', async (machine) => { lookups.push(machine); return credentials[machine] })
  h.wc.setUrl(url)
  h.watcher.setRefs(refTable(1, [
    ['s1-e0', { backendNodeId: 1, role: 'textbox', name: '帳號' }],
    ['s1-e1', { backendNodeId: 2, role: 'textbox', name: '密碼' }],
    ['s1-e2', { backendNodeId: 3, role: 'button', name: '登入' }],
    ['s1-e3', { backendNodeId: 4, role: 'textbox', name: '外站', sessionId: 'oopif-1' }],
  ]))
  for (const method of ['DOM.focus', 'Input.dispatchKeyEvent', 'Input.insertText', 'DOM.scrollIntoViewIfNeeded', 'Input.dispatchMouseEvent']) {
    h.cdp.onSend(method, () => ({}))
  }
  h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: ROOT_BORDER } }))
  h.cdp.onSend('DOM.describeNode', (params) => {
    const { backendNodeId } = params as { backendNodeId: number }
    const node = NODES[backendNodeId]
    if (node === undefined) throw new Error(`測試沒有預錄 backendNodeId ${backendNodeId} 的節點`)
    return { node }
  })
}

/** 每次 Input.insertText 送出的文字,依序。 */
const inserted = () => sent(h.cdp, 'Input.insertText').map((c) => (c.params as { text: string }).text)
/** 送出的 Input.* 指令數。 */
const inputCount = () => (h.cdp.send as unknown as Mock).mock.calls.filter((c) => String(c[0]).startsWith('Input.')).length

/**
 * 送出(click／press Enter)之後 login 會等頁面靜默(settle.ts 的 500ms 靜默窗)。
 * 手動時鐘不會自己跑,所以跟 controller-input.test.ts 的 quietOk 一樣先讓微任務
 * 排空(tick)、再把時鐘推進 500ms,呼叫端才收得到 resolve。
 */
async function loginAndSettle(
  machine: string,
  usernameRef: string,
  passwordRef: string,
  submitRef: string | undefined
): ReturnType<typeof h.controller.login> {
  const promise = h.controller.login(machine, usernameRef, passwordRef, submitRef, h.signal)
  await tick()
  h.advance(500)
  return promise
}

beforeEach(() => setup())

describe('view_login 的前置檢查', () => {
  it('沒有這台測試機:回 machineUnknown,不送任何 Input 指令', async () => {
    await expect(h.controller.login('nope', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machineUnknown('nope'))
    expect(inputCount()).toBe(0)
    expect(lookups).toEqual(['nope'])
  })

  it('沒設密碼:回 machineNoPassword', async () => {
    await setup({ staging: { ...STAGING, password: null } })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machineNoPassword('staging'))
    expect(inputCount()).toBe(0)
  })

  it('密文解不開:回 machinePasswordUnreadable', async () => {
    await setup({ staging: { ...STAGING, password: null, passwordUnreadable: true } })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.machinePasswordUnreadable('staging'))
    expect(inputCount()).toBe(0)
  })

  it('目前頁面的 origin 不是測試機的:回 originMismatch,不送任何 Input 指令', async () => {
    await setup({ staging: STAGING }, 'https://evil.test/login')
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.originMismatch('https://staging.test'))
    expect(inputCount()).toBe(0)
  })

  it('同 origin 不同路徑可以', async () => {
    await setup({ staging: STAGING }, 'https://staging.test/admin/login?next=/')
    await expect(loginAndSettle('staging', 's1-e0', 's1-e1', undefined)).resolves.toMatchObject({ kind: 'text' })
  })

  it('ref 壞掉:格式錯、不在表裡,各回對應訊息且不送 Input', async () => {
    await expect(h.controller.login('staging', 'x', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.refFormat)
    await expect(h.controller.login('staging', 's1-e0', 's1-e9', undefined, h.signal)).rejects.toThrow(MSG.refMissing(1, 's1-e9'))
    expect(inputCount()).toBe(0)
  })

  it('任一個 ref 在跨站 iframe 裡:回 loginRefInFrame,不送 Input', async () => {
    await expect(h.controller.login('staging', 's1-e3', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.loginRefInFrame)
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', 's1-e3', h.signal)).rejects.toThrow(MSG.loginRefInFrame)
    expect(inputCount()).toBe(0)
  })

  it('passwordRef 指到非密碼欄位:回 loginNotPasswordField,不送 Input', async () => {
    // s1-e0 是帳號欄(type=text),拿它當密碼欄應該被拒絕。
    await expect(h.controller.login('staging', 's1-e0', 's1-e0', undefined, h.signal)).rejects.toThrow(MSG.loginNotPasswordField('s1-e0'))
    expect(inputCount()).toBe(0)
  })

  it('usernameRef 指到密碼欄位:回 loginNotUsernameField,不送 Input', async () => {
    // s1-e1 是密碼欄,拿它當帳號欄應該被拒絕。
    await expect(h.controller.login('staging', 's1-e1', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.loginNotUsernameField('s1-e1'))
    expect(inputCount()).toBe(0)
  })

  it('submitRef 指到非按鈕欄位:回 loginNotSubmitButton,不送 Input', async () => {
    // s1-e0 是帳號欄(textbox),拿它當送出鈕應該被拒絕。
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', 's1-e0', h.signal)).rejects.toThrow(MSG.loginNotSubmitButton('s1-e0'))
    expect(inputCount()).toBe(0)
  })

  it('節點型別檢查時 DOM.describeNode 失敗(元素已不在):回 refDetached,不送 Input', async () => {
    h.cdp.onSend('DOM.describeNode', () => { throw new Error('No node with given id found') })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow(MSG.refDetached('s1-e0'))
    expect(inputCount()).toBe(0)
  })
})

describe('填表與送出', () => {
  it('沒有 submitRef:帳號、密碼依序填入,密碼欄按 Enter,最後清空密碼欄', async () => {
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', undefined)
    expect(inserted()).toEqual(['qa', 's3cret', ''])
    const enters = sent(h.cdp, 'Input.dispatchKeyEvent').filter((c) => (c.params as { key?: string }).key === 'Enter')
    expect(enters.length).toBeGreaterThan(0)
    expect(out).toEqual({ kind: 'text', text: MSG.loggedIn('staging', 'https://staging.test/login') })
    // Enter 是送出動作,一定在最後一次 insertText(清空密碼欄)之前送出。
    const calls = (h.cdp.send as unknown as Mock).mock.calls
    const enterIndex = calls.findIndex((c) => c[0] === 'Input.dispatchKeyEvent' && (c[1] as { key?: string }).key === 'Enter')
    let lastInsertIndex = -1
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i]?.[0] === 'Input.insertText') { lastInsertIndex = i; break }
    }
    expect(enterIndex).toBeGreaterThanOrEqual(0)
    expect(enterIndex).toBeLessThan(lastInsertIndex)
  })

  it('有 submitRef:點它而不是按 Enter', async () => {
    await loginAndSettle('staging', 's1-e0', 's1-e1', 's1-e2')
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(2)
    expect(sent(h.cdp, 'Input.dispatchKeyEvent').filter((c) => (c.params as { key?: string }).key === 'Enter')).toHaveLength(0)
    expect(inserted()).toEqual(['qa', 's3cret', ''])
  })

  it('回傳文字與 log 都不含帳號與密碼', async () => {
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', undefined)
    const text = JSON.stringify(out)
    expect(text).not.toContain('qa')
    expect(text).not.toContain('s3cret')
    // 這裡沒有任何一步失敗,logError 完全不會被呼叫——比對「序列化後的空陣列不含
    // 's3cret'」永遠成立,測不出東西(I4),真正有意義的斷言是它壓根沒被呼叫。
    expect(h.logError).not.toHaveBeenCalled()
  })

  it('送出後網址帶 query／hash(GET 表單或帶 token 的轉址):回傳文字只留 origin+pathname(C2)', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://staging.test/home?token=abc&pass=s3cret')
      return {}
    })
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', 's1-e2')
    expect(out).toEqual({ kind: 'text', text: MSG.loggedIn('staging', 'https://staging.test/home') })
    const serialized = JSON.stringify(out)
    expect(serialized).toContain('https://staging.test/home')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('s3cret')
  })

  it('送出時失敗(點擊丟例外):仍然清空密碼欄,錯誤原樣往上丟', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => { throw new Error('boom') })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', 's1-e2', h.signal)).rejects.toThrow()
    expect(inserted().at(-1)).toBe('')
  })

  it('填密碼之後 signal 中止:仍然清空密碼欄', async () => {
    let calls = 0
    h.cdp.onSend('Input.insertText', () => {
      calls += 1
      if (calls === 2) h.aborter.abort()
      return {}
    })
    await expect(h.controller.login('staging', 's1-e0', 's1-e1', undefined, h.signal)).rejects.toThrow()
    expect(inserted()).toEqual(['qa', 's3cret', ''])
  })

  it('送出後頁面跳轉、ref 表失效:清空這一步略過,不記錯誤', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://staging.test/home')
      h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'navigated'))
      return {}
    })
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', 's1-e2')
    expect(inserted()).toEqual(['qa', 's3cret'])
    expect(h.logError).not.toHaveBeenCalled()
    expect(out).toEqual({ kind: 'text', text: MSG.loggedIn('staging', 'https://staging.test/home') })
  })

  it('送出後 ref 表因使用者輸入失效:清空失敗要記錯誤,回傳文字要加警告(I3)', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'userInput'))
      return {}
    })
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', 's1-e2')
    expect(inserted()).toEqual(['qa', 's3cret'])
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.loggedIn('staging', 'https://staging.test/login')}\n${MSG.loginClearFailed}`,
    })
    expect(h.logError).toHaveBeenCalledTimes(1)
    const [error] = h.logError.mock.calls[0] as [Error]
    expect(error.message).toContain('密碼可能還留在欄位裡')
    expect(error.message).not.toContain('s3cret')
    // I4:JSON.stringify(Error) 序列化成 '{}'(message／stack 不是可列舉屬性),
    // 舊的 `expect(JSON.stringify(h.logError.mock.calls)).not.toContain('s3cret')`
    // 不管密碼有沒有外洩都會過,例如 `JSON.stringify([[new Error('s3cret')]])` === '[[{}]]'。
    // 這裡直接檢查 cause 本身與 cause.message,才是真的測到有沒有洩漏。
    expect(String(error.cause)).not.toContain('s3cret')
    expect(String((error.cause as Error | undefined)?.message)).not.toContain('s3cret')
  })

  it('清空時 CDP 失敗要記錯誤,回傳文字要加警告(I3)', async () => {
    let calls = 0
    h.cdp.onSend('Input.insertText', () => {
      calls += 1
      if (calls === 3) throw new Error('CDP 掛了')
      return {}
    })
    const out = await loginAndSettle('staging', 's1-e0', 's1-e1', undefined)
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.loggedIn('staging', 'https://staging.test/login')}\n${MSG.loginClearFailed}`,
    })
    expect(h.logError).toHaveBeenCalledTimes(1)
    const [error] = h.logError.mock.calls[0] as [Error]
    expect(error.message).toContain('密碼可能還留在欄位裡')
    expect(error.message).not.toContain('s3cret')
    expect(String(error.cause)).not.toContain('s3cret')
    expect(String((error.cause as Error | undefined)?.message)).not.toContain('s3cret')
  })
})
