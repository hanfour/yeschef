import { describe, it, expect } from 'vitest'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { CdpError } from '../../src/main/cdp.js'

describe('createFakeCdp: emit / onEvent', () => {
  it('emit 觸發所有已訂閱的 listener，依註冊順序', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    cdp.onEvent(() => calls.push('a'))
    cdp.onEvent(() => calls.push('b'))
    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['a', 'b'])
  })

  it('unsubscribe 之後不再收到 emit', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    const unsubscribe = cdp.onEvent(() => calls.push('x'))
    cdp.emit('Page.loadEventFired', {})
    unsubscribe()
    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['x'])
  })

  it('unsubscribe 在 listener 回呼中呼叫也安全：這次廣播不跳過下一個 listener', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => {}
    cdp.onEvent(() => { calls.push('first'); unsubscribeSecond() })
    unsubscribeSecond = cdp.onEvent(() => calls.push('second'))
    cdp.onEvent(() => calls.push('third'))
    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['first', 'second', 'third'])
    calls.length = 0
    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['first', 'third'])
  })

  it('sessionId 省略或空字串都視為主 target，listener 收到 undefined；有值則原樣傳遞', () => {
    const cdp = createFakeCdp()
    const received: (string | undefined)[] = []
    cdp.onEvent((_method, _params, sessionId) => received.push(sessionId))
    cdp.emit('Page.loadEventFired', {})
    cdp.emit('Page.loadEventFired', {}, '')
    cdp.emit('Network.requestWillBeSent', {}, 'child-1')
    expect(received).toEqual([undefined, undefined, 'child-1'])
  })

  it('params 原樣傳給 listener，不做任何轉換', () => {
    const cdp = createFakeCdp()
    let received: unknown
    cdp.onEvent((_method, params) => { received = params })
    const params = { requestId: 'r1' }
    cdp.emit('Network.requestWillBeSent', params)
    expect(received).toBe(params)
  })
})

describe('createFakeCdp: send 預錄回應', () => {
  it('依 method 預錄回應，send 回傳預錄的值', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }))
    await expect(cdp.send('Page.getLayoutMetrics')).resolves.toEqual({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } })
  })

  it('同一個 method 依 sessionId 精確匹配，找不到才退回無 sessionId 的那份', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: 'root' } }))
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: 'child' } }), 'child-1')
    await expect(cdp.send('DOM.getBoxModel')).resolves.toEqual({ model: { border: 'root' } })
    await expect(cdp.send('DOM.getBoxModel', undefined, 'child-1')).resolves.toEqual({ model: { border: 'child' } })
    await expect(cdp.send('DOM.getBoxModel', undefined, 'other-session')).resolves.toEqual({ model: { border: 'root' } })
  })

  it('responder 丟例外時 send 回傳的 promise reject', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('DOM.getBoxModel', () => { throw new CdpError('找不到節點', '-32000') })
    await expect(cdp.send('DOM.getBoxModel')).rejects.toThrow('找不到節點')
  })

  it('沒有預錄回應時 send reject 並在錯誤訊息裡帶 method 名稱', async () => {
    await expect(createFakeCdp().send('Runtime.evaluate')).rejects.toThrow(/Runtime\.evaluate/)
  })

  it('帶 sessionId 呼叫但完全沒有預錄時，錯誤訊息裡也帶上 sessionId', async () => {
    await expect(createFakeCdp().send('DOM.focus', undefined, 'child-1')).rejects.toThrow(/sessionId=child-1/)
  })

  it('onSend 對同一組 method／sessionId 覆蓋預錄', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.navigate', () => ({ frameId: 'f1' }))
    cdp.onSend('Page.navigate', () => ({ frameId: 'f2' }))
    await expect(cdp.send('Page.navigate')).resolves.toEqual({ frameId: 'f2' })
  })

  it('send 是 vi.fn()，可以用 toHaveBeenCalledWith 斷言呼叫參數', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Input.dispatchMouseEvent', () => ({}))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, 'child-1')
    expect(cdp.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, 'child-1')
  })
})

describe('createFakeCdp: attached targets 與 rearm errors', () => {
  it('setAttachedTargets 之後 getAttachedTargets 回同一份內容', () => {
    const cdp = createFakeCdp()
    const targets = [{ targetId: 't1', type: 'iframe', url: 'https://child.example/', sessionId: 'child-1' }]
    cdp.setAttachedTargets(targets)
    expect(cdp.getAttachedTargets()).toEqual(targets)
  })
  it('未呼叫 setAttachedTargets 時預設是空陣列', () => {
    expect(createFakeCdp().getAttachedTargets()).toEqual([])
  })
  it('setRearmErrors 之後 getRearmErrors 回同一份內容', () => {
    const cdp = createFakeCdp()
    const errors = [new CdpError('setAutoAttach 失敗', '-32000')]
    cdp.setRearmErrors(errors)
    expect(cdp.getRearmErrors()).toEqual(errors)
  })
  it('未呼叫 setRearmErrors 時預設是空陣列', () => {
    expect(createFakeCdp().getRearmErrors()).toEqual([])
  })
})

describe('createFakeCdp: detach', () => {
  it('detach 是 vi.fn()，可以斷言有沒有被呼叫', () => {
    const cdp = createFakeCdp()
    cdp.detach()
    expect(cdp.detach).toHaveBeenCalledTimes(1)
  })
})
