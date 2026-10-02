import { describe, expect, it } from 'vitest'
import type { PlaceableView } from '../src/main/browser-placement.js'
import { createViewSwitch } from '../src/main/view-switch.js'

function fakeView(name: string, calls: string[]): PlaceableView {
  return {
    setBounds: (b) => { calls.push(`${name}:bounds:${b.x},${b.y},${b.width},${b.height}`) },
    setVisible: (v) => { calls.push(`${name}:visible:${String(v)}`) },
  }
}

describe('view 轉接物件', () => {
  it('沒有目標時 setBounds 與 setVisible 都不做事,也不丟例外', () => {
    const sw = createViewSwitch()
    expect(() => { sw.setBounds({ x: 0, y: 0, width: 1, height: 1 }); sw.setVisible(true) }).not.toThrow()
  })

  it('指令轉給目前的目標', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    sw.target(fakeView('a', calls))
    sw.setVisible(true)
    sw.setBounds({ x: 1, y: 2, width: 3, height: 4 })
    expect(calls).toEqual(['a:visible:true', 'a:bounds:1,2,3,4'])
  })

  it('換目標時先把舊的藏起來;新的不主動顯示,等 placement 來套', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    sw.target(fakeView('a', calls))
    sw.target(fakeView('b', calls))
    expect(calls).toEqual(['a:visible:false'])
  })

  it('目標改成 null 會藏掉舊的;同一個目標再指定一次不做事', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    const a = fakeView('a', calls)
    sw.target(a)
    sw.target(a)
    sw.target(null)
    expect(calls).toEqual(['a:visible:false'])
  })
})
