import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import type { AttachedTargetInfo } from '../../src/main/cdp.js'
import {
  MAX_BOX_LOOKUPS,
  collectSnapshotInput,
  resolveFrameOffset,
} from '../../src/main/view-tools/snapshot-collect.js'
import type { CollectDeps } from '../../src/main/view-tools/snapshot-collect.js'
import { buildSnapshot, formatSnapshotText } from '../../src/main/view-tools/snapshot.js'
import type { AxRawNode } from '../../src/main/view-tools/snapshot.js'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import type { FakeCdp } from '../helpers/fake-cdp.js'

/** 軸對齊的 quad：[x1,y1,x2,y2,x3,y3,x4,y4]，順序是左上、右上、右下、左下。 */
function quad(x: number, y: number, width: number, height: number): readonly number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height]
}

/**
 * DOM.getBoxModel 的預錄回應：同一個 model 同時給 border 與 content。
 * 兩者查的是不同的 backendNodeId（節點的矩形 vs iframe 擁有者的矩形），
 * 不會互相干擾，測試因此不必為同一個 session 開兩份預錄。
 */
function boxModel(byId: Readonly<Record<number, readonly number[]>>) {
  return (params: object | undefined): unknown => {
    const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId
    const q = id === undefined ? undefined : byId[id]
    if (q === undefined) throw new CdpError(`沒有 node ${String(id)} 的 box model`, 'no-box-model')
    return { model: { border: q, content: q } }
  }
}

function axNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  extra: Partial<AxRawNode> = {}
): AxRawNode {
  return { nodeId, ignored: false, role: { value: role }, name: { value: name }, backendDOMNodeId, ...extra }
}

function frameTree(id: string, url: string, children: readonly { id: string; url: string }[] = []): unknown {
  return { frameTree: { frame: { id, url }, childFrames: children.map((c) => ({ frame: { id: c.id, url: c.url } })) } }
}

function target(targetId: string, sessionId: string, url: string, type = 'iframe'): AttachedTargetInfo {
  return { targetId, type, url, sessionId }
}

function makeDeps(cdp: FakeCdp): { deps: CollectDeps; errors: Error[] } {
  const errors: Error[] = []
  const deps: CollectDeps = {
    cdp,
    currentUrl: () => 'https://a.test/order',
    currentTitle: () => '訂單確認',
    now: () => 1700,
    logError: (e) => {
      errors.push(e)
    },
  }
  return { deps, errors }
}

/** 最小可用的樁：viewport 1024×768、一個主 frame、沒有 iframe。 */
function basicCdp(nodes: readonly AxRawNode[], byId: Readonly<Record<number, readonly number[]>>): FakeCdp {
  const cdp = createFakeCdp()
  cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
  cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
  cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes }))
  cdp.onSend('DOM.getBoxModel', boxModel(byId))
  return cdp
}

function methodCalls(cdp: FakeCdp, method: string): readonly unknown[][] {
  return (cdp.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === method)
}

describe('collectSnapshotInput：基本欄位與 viewport', () => {
  it('id、scope 與 deps 的 now／url／title 原樣帶進 SnapshotInput，viewport 取 cssVisualViewport 且 x、y 為 0', async () => {
    const cdp = basicCdp([], {})
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 7, 'full')
    expect(input.id).toBe(7)
    expect(input.scope).toBe('full')
    expect(input.takenAt).toBe(1700)
    expect(input.url).toBe('https://a.test/order')
    expect(input.title).toBe('訂單確認')
    // 寬高刻意不同，x/y 或 width/height 互換的實作會被抓到。
    expect(input.viewport).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('cssVisualViewport 沒有寬高時丟 CdpError（code invalid-response），不是靜靜回 0', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => ({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }))
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'invalid-response',
    })
  })

  it('Page.getLayoutMetrics 失敗時錯誤往外丟，不吞掉', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => {
      throw new CdpError('目標已關閉', 'targetClosed')
    })
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({ code: 'targetClosed' })
  })

  it('root session 的 Page.getFrameTree 失敗時錯誤往外丟', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getFrameTree', () => {
      throw new CdpError('主頁已關閉', 'rootClosed')
    })
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({ code: 'rootClosed' })
  })

  it('root 的 Page.getFrameTree 回傳沒有 frameTree.frame.id 時丟 invalid-response', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getFrameTree', () => ({}))
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'invalid-response',
    })
  })

  it('takenAt、url、title 在任何 CDP 往返前取值', async () => {
    let beforeCdp = true
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => {
      beforeCdp = false
      return { cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }
    })
    const deps: CollectDeps = {
      cdp,
      currentUrl: () => (beforeCdp ? 'https://old.test/' : 'https://new.test/'),
      currentTitle: () => (beforeCdp ? '舊標題' : '新標題'),
      now: () => (beforeCdp ? 1 : 2),
      logError: () => {},
    }
    const input = await collectSnapshotInput(deps, 1, 'viewport')
    expect(input.takenAt).toBe(1)
    expect(input.url).toBe('https://old.test/')
    expect(input.title).toBe('舊標題')
  })
})
describe('collectSnapshotInput：frame 發現（裁決 6）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  it('root 的 frame 樹遞迴攤平，同行程子 frame 的 sessionId 是 undefined，主 frame 排在最前', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'F-child'])
    expect(input.frames.map((f) => f.sessionId)).toEqual([undefined, undefined])
    expect(input.frames[1]?.url).toBe('https://a.test/side')
  })

  it('getAttachedTargets 的 iframe target 成為 frame（frameId 就是 targetId），非 iframe 的 target 不算', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([
      target('T-oopif', 's-oopif', 'https://pay.test/'),
      target('T-worker', 's-worker', 'https://a.test/sw.js', 'service_worker'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(input.frames[1]?.sessionId).toBe('s-oopif')
    expect(input.frames[1]?.url).toBe('https://pay.test/')
  })

  it('iframe target 自己的 frame 樹也攤平，且跟 target 重複的 frameId 只出現一次', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-oopif', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif', 'F-inner'])
    expect(input.frames[2]?.sessionId).toBe('s-oopif')
  })

  it('iframe target 的 Page.getFrameTree 失敗只記錄，target 本身仍然是一個 frame', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => {
        throw new CdpError('session 已關閉', 'sessionClosed')
      },
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(errors.map((e) => e.message).join('\n')).toContain('T-oopif')
    expect(input.unattachedFrames).toBe(0)
  })
})

describe('collectSnapshotInput：unattachedFrames（裁決 6 第 3、4 點）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  function withTwoOopifs(): FakeCdp {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) })
    cdp.setAttachedTargets([target('T-a', 's-a', 'https://a.pay/'), target('T-b', 's-b', 'https://b.pay/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-a', 'https://a.pay/'), 's-a')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-b', 'https://b.pay/'), 's-b')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-a', type: 'iframe', parentId: 'T-page' },
        { targetId: 'T-b', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    return cdp
  }

  it('AX 樹抓不到的 frame 略過、計入 unattachedFrames 並記錄錯誤', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('T-a'))).toBe(true)
  })

  it('getFullAXTree 回傳沒有 nodes 陣列時視同抓不到', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({}), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('nodes'))).toBe(true)
  })

  it('getRearmErrors 非空、但所有 frame 的 AX 樹都抓得到時，unattachedFrames 仍至少是 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames).toHaveLength(3)
    expect(input.unattachedFrames).toBe(1)
  })

  it('getRearmErrors 非空且已經有兩個 frame 抓不到時，維持 2 而不是被壓成 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-b'
    )
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(2)
  })

  it('getRearmErrors 為空、frame 都正常時 unattachedFrames 是 0', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(0)
  })
})
describe('resolveFrameOffset（裁決 7）', () => {
  /**
   * 兩層 OOPIF：T-outer 在頁面裡的 (100, 40)，T-inner 在 T-outer 座標系裡的 (7, 13)。
   * 每一層的 x 與 y 都不同、都不是 0，所以「只加自己那層」「只加父層」「x 與 y 寫反」
   * 三種錯法都會得到跟 (107, 53) 不同的值。
   */
  function nestedCdp(): FakeCdp {
    const cdp = basicCdp([], {})
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    // root session（父是頁面本身）算 T-outer 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 900: quad(100, 40, 300, 200) }))
    // s-outer session 算 T-inner 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 901 }), 's-outer')
    cdp.onSend('DOM.getBoxModel', boxModel({ 901: quad(7, 13, 120, 60) }), 's-outer')
    return cdp
  }

  it('sessionId 為 undefined（root）時直接回 {0,0}，一個 CDP 指令都不發', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, undefined)).toEqual({ x: 0, y: 0 })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it('單層 OOPIF：offset 就是父 session 裡 content 的左上角', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
    expect(errors).toEqual([])
  })

  it('兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await resolveFrameOffset(deps, 's-inner')
    const owners = methodCalls(cdp, 'DOM.getFrameOwner')
    expect(owners).toEqual([
      ['DOM.getFrameOwner', { frameId: 'T-inner' }, 's-outer'],
      ['DOM.getFrameOwner', { frameId: 'T-outer' }, undefined],
    ])
  })

  it('Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-somebody-else', type: 'iframe', parentId: 'T-page' }],
    }))
    const { deps, errors } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'frame-detached',
    })
    // 容忍與否由呼叫端決定，函式本身不記錄也不回退。
    expect(errors).toEqual([])
  })

  it('TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentFrameId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentFrameId: 'T-page' },
      ],
    }))
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('TargetInfo 有這個 target 但兩個父欄位都沒有時往外丟 frame-detached', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-outer', type: 'iframe' }] }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('getAttachedTargets 裡沒有這個 sessionId 時往外丟 frame-detached，不發任何指令', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-unknown')).rejects.toMatchObject({ code: 'frame-detached' })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
  })

  it('DOM.getFrameOwner 失敗時把原本的 CdpError 原樣往外丟，不換成別的 code', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => {
      throw new CdpError('找不到 frame owner', 'noNode')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'noNode' })
  })

  it('DOM.getFrameOwner 沒有回傳 backendNodeId 時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => ({}))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('backendNodeId'),
    })
  })

  it('Target.getTargets 失敗時把原本的 CdpError 原樣往外丟', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => {
      throw new CdpError('debugger 已卸除', 'detached')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'detached' })
  })

  it('父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）', async () => {
    const cdp = nestedCdp()
    // T-inner 在 T-outer 裡的位置查得到，但 T-outer 自己的父 target 查不到。
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' }],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('content 的四點順序打亂時取最小外接矩形的左上角', async () => {
    const cdp = nestedCdp()
    // 右下、左下、左上、右上：左上角仍應是 (100, 40)。
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [400, 240, 100, 240, 100, 40, 400, 40] } }))
    const { deps } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
  })

  it('content 不是八個數字時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [100, 40] } }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('父欄位成環時往外丟 invalid-response，不會無限打轉', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-inner' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
      ],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('迴圈'),
    })
  })

  it('同一次 snapshot 內同一個 session 只算一次（快取）', async () => {
    const cdp = nestedCdp()
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-outer', 'https://outer.test/'), 's-outer')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-inner', 'https://inner.test/'), 's-inner')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 40 },
      { x: 107, y: 53 },
    ])
    // s-outer 出現在兩條解析路徑上（自己一次、s-inner 的父鏈一次），只能查一次 parentId。
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(2)
  })
})
describe('collectSnapshotInput 對 offset 失敗的處置（裁決 29）', () => {
  it('offset 算不出來時該 frame 用 {0,0}、記錄一次，frame 與它的節點照常列入', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], { 11: quad(10, 20, 30, 40), 21: quad(5, 6, 30, 40) })
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    // 同一個 session 底下兩個 frame，錯誤只該記一次。
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-pay', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-pay'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-pay')
    // T-pay 不在 Target.getTargets 的清單裡：resolveFrameOffset 丟 frame-detached。
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-other', type: 'iframe' }] }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay', 'F-inner'])
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
    // 節點與矩形照常蒐集：view_type 不需要座標，ref 仍然可用。
    expect([...(input.frames[1]?.boxes.keys() ?? [])]).toEqual([21])
    expect(input.frames[1]?.nodes).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('s-pay')
  })
})

describe('collectSnapshotInput：box 蒐集', () => {
  it('只對角色白名單內、未 ignored 且有 backendDOMNodeId 的節點查 box', async () => {
    const nodes: readonly AxRawNode[] = [
      axNode('1', 'RootWebArea', '訂單確認', 1),
      axNode('2', 'button', '送出', 11),
      axNode('3', 'heading', '訂單', 12),
      axNode('4', 'generic', '', 13),
      axNode('5', 'StaticText', '送出', 14),
      axNode('6', 'button', '隱藏', 15, { ignored: true }),
      { nodeId: '7', ignored: false, role: { value: 'link' }, name: { value: '沒有節點' } },
    ]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40), 12: quad(1, 2, 3, 4) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel').map((c) => c[1])).toEqual([{ backendNodeId: 11 }, { backendNodeId: 12 }])
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11, 12])
    expect(errors).toEqual([])
  })

  it('border 取四點的最小外接矩形，順序打亂與非軸對齊都算得出來', async () => {
    const nodes = [axNode('1', 'button', '送出', 11)]
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: [30, 5, 50, 25, 30, 45, 10, 25] } }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames[0]?.boxes.get(11)).toEqual({ x: 10, y: 5, width: 40, height: 40 })
  })

  it('getBoxModel 失敗的節點不進 boxes，也不記錄錯誤（display: none 是常態）', async () => {
    const nodes = [axNode('1', 'button', '送出', 11), axNode('2', 'button', '隱藏', 12)]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11])
    expect(errors).toEqual([])
  })

  it('所有 DOM.getBoxModel 都失敗時只記錄一次彙總錯誤', async () => {
    const nodes = [axNode('1', 'button', '甲', 11), axNode('2', 'heading', '乙', 12)]
    const cdp = basicCdp(nodes, {})
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames[0]?.boxes).toEqual(new Map())
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('F-root')
    expect(errors[0]?.message).toContain('2 個候選節點')
    expect(errors[0]?.message).toContain('2 次 DOM.getBoxModel 失敗')
  })

  it('box 查詢送到該 frame 的 sessionId', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], {
      11: quad(10, 20, 30, 40),
      21: quad(1, 2, 3, 4),
      900: quad(100, 40, 300, 200),
    })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    const { deps } = makeDeps(cdp)
    await collectSnapshotInput(deps, 1, 'full')
    const calls = methodCalls(cdp, 'DOM.getBoxModel')
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 11 }, undefined])
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 21 }, 's-oopif'])
  })
})

describe('collectSnapshotInput：MAX_BOX_LOOKUPS（裁決 7）', () => {
  function manyNodes(prefix: string, count: number, firstId: number): readonly AxRawNode[] {
    return Array.from({ length: count }, (_, i) => axNode(`${prefix}${i}`, 'button', `按鈕 ${i}`, firstId + i))
  }

  it('額度跨 frame 共用：兩個各 800 個候選的 frame 只查 1500 次，多的不查也不進 boxes，並記錄一次', async () => {
    const first = manyNodes('a', 800, 1000)
    const second = manyNodes('b', 800, 5000)
    const cdp = basicCdp(first, {})
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    cdp.onSend('Accessibility.getFullAXTree', (params) =>
      (params as { frameId?: string } | undefined)?.frameId === 'F-child' ? { nodes: second } : { nodes: first }
    )
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(800)
    expect(input.frames[1]?.boxes.size).toBe(700)
    // 第二個 frame 的第 701 個之後沒有矩形：buildSnapshot 規則 2 會把它們當不存在。
    expect(input.frames[1]?.boxes.has(5699)).toBe(true)
    expect(input.frames[1]?.boxes.has(5700)).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('100')
  })

  it('候選數剛好等於上限時全部查完，不記錄錯誤', async () => {
    const nodes = manyNodes('a', MAX_BOX_LOOKUPS, 1000)
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(MAX_BOX_LOOKUPS)
    expect(errors).toEqual([])
  })
})

describe('collectSnapshotInput 的輸出直接餵得進 buildSnapshot', () => {
  const FORM_AX = JSON.parse(readFileSync('tests/fixtures/ax/form.json', 'utf8')) as { nodes: readonly AxRawNode[] }

  /** fixture 的 backendDOMNodeId → 矩形。刻意全部落在 viewport 內。 */
  const FORM_BOXES: Readonly<Record<number, readonly number[]>> = {
    101: quad(120, 80, 200, 32), // heading 訂單
    104: quad(120, 140, 240, 24), // textbox 電子郵件
    106: quad(120, 180, 240, 24), // textbox 收件人
    108: quad(120, 220, 16, 16), // checkbox 訂閱電子報
    110: quad(120, 260, 80, 30), // button 刪除
    114: quad(120, 300, 60, 20), // link 說明
    116: quad(120, 340, 100, 100), // image 商品圖
    117: quad(120, 460, 100, 100), // image（沒有 alt）
  }

  it('form.json 加一個 OOPIF：ref 連續編號、OOPIF 節點的 bounds 已經加上 offset、未附著數進文字', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
    cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
    cdp.onSend('Page.getFrameTree', () => frameTree('T-pay', 'https://pay.test/'), 's-pay')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: FORM_AX.nodes }))
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => ({
        nodes: [
          { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: '付款' }, childIds: ['2'] },
          axNode('2', 'button', '確認付款', 201),
        ],
      }),
      's-pay'
    )
    cdp.onSend('DOM.getBoxModel', boxModel({ ...FORM_BOXES, 900: quad(100, 40, 300, 200) }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 201: quad(8, 12, 120, 30) }), 's-pay')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-pay', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])

    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 12, 'viewport')
    const { snapshot, refs } = buildSnapshot(input)
    const text = formatSnapshotText(snapshot)

    expect(snapshot.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay'])
    expect(refs.snapshotId).toBe(12)
    expect(refs.entries.get('s12-e0')).toEqual({ backendNodeId: 104, role: 'textbox', name: '電子郵件' })
    expect(refs.entries.get('s12-e4')).toEqual({ backendNodeId: 114, role: 'link', name: '說明' })
    // 編號跨 frame 連續：主 frame 用掉 e0 到 e4，OOPIF 的按鈕接在 e5。
    expect(refs.entries.get('s12-e5')).toEqual({
      sessionId: 's-pay',
      backendNodeId: 201,
      role: 'button',
      name: '確認付款',
    })
    // OOPIF 的按鈕在自己 frame 裡是 (8, 12)，加上 iframe 在主視窗的 (100, 40)。
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 108, y: 52, width: 120, height: 30 })
    expect(text.split('\n')[0]).toBe('[iframe 未附著 1 個]')
    expect(text).toContain('[page] 訂單確認 https://a.test/order')
    expect(text).toContain('[iframe 1] https://pay.test/')
    expect(text).toContain('s12-e5 button "確認付款"')
    // 沒有 alt 的 image（name 為空）由 buildSnapshot 規則 2 濾掉，不佔行。
    expect(text).not.toContain('image ""')
  })
})
