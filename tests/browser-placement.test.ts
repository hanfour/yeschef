import { describe, expect, it } from 'vitest'
import { createBrowserPlacement, type PlaceableView } from '../src/main/browser-placement.js'

function fakeView() {
  const calls: string[] = []
  const view: PlaceableView = {
    setBounds: (b) => { calls.push(`bounds:${b.x},${b.y},${b.width},${b.height}`) },
    setVisible: (v) => { calls.push(`visible:${String(v)}`) },
  }
  return { view, calls }
}

function setup(zoom = 1, size = { width: 1600, height: 900 }) {
  const { view, calls } = fakeView()
  let z = zoom
  let s = size
  const placement = createBrowserPlacement({ view, zoomFactor: () => z, contentSize: () => s })
  return {
    placement, calls,
    setZoom: (next: number) => { z = next },
    setSize: (next: { width: number; height: number }) => { s = next },
  }
}

describe('瀏覽器擺放', () => {
  it('renderer 還沒回報前先藏著,視窗改大小也不會跑出來', () => {
    const { placement, calls } = setup()
    placement.relayout()
    expect(calls).toEqual(['visible:false'])
  })

  it('照回報的矩形擺,乘上縮放倍率並取整數', () => {
    const { placement, calls } = setup(1.25)
    // y: 30 × 1.25 = 37.5,取整數是 38
    placement.report({ x: 640, y: 30, width: 640, height: 600 })
    expect(calls).toEqual(['visible:false', 'visible:true', 'bounds:800,38,800,750'])
  })

  it('回報 null 就藏起來,之後視窗改大小也不會跑出來', () => {
    const { placement, calls, setSize } = setup()
    placement.report(null)
    setSize({ width: 1200, height: 800 })
    placement.relayout()
    // 建立時一筆、report(null) 一筆;relayout 不再碰它
    expect(calls).toEqual(['visible:false', 'visible:false'])
  })

  it('超出視窗的部分切掉,切完沒有面積就藏起來', () => {
    const { placement, calls } = setup(1, { width: 1000, height: 800 })
    placement.report({ x: 900, y: 0, width: 400, height: 900 })
    expect(calls).toEqual(['visible:false', 'visible:true', 'bounds:900,0,100,800'])
    placement.report({ x: 1200, y: 0, width: 400, height: 900 })
    expect(calls.at(-1)).toBe('visible:false')
  })

  it('視窗改大小時用新的尺寸重新切一次', () => {
    const { placement, calls, setSize } = setup(1, { width: 1600, height: 900 })
    placement.report({ x: 800, y: 0, width: 800, height: 900 })
    setSize({ width: 1000, height: 900 })
    placement.relayout()
    expect(calls.at(-1)).toBe('bounds:800,0,200,900')
  })

  it('縮放不是 1 時底邊不會多出 1px', () => {
    const { placement, calls } = setup(1.25, { width: 2000, height: 1200 })
    placement.report({ x: 801, y: 38, width: 799, height: 834 })
    // 底邊 (38 + 834) × 1.25 = 1090,各自取整數的話會是 48 + 1043 = 1091
    expect(calls.at(-1)).toBe('bounds:1001,48,999,1042')
  })
})
