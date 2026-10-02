/**
 * 輸入層級的三個工具：view_click、view_type、view_press。
 *
 * 三個共同點：Input.* 一律送 root session（CDP 的輸入是頁面層級的，送到
 * OOPIF 的 session 反而打不到主視窗座標系），而 DOM.* 送節點所屬的 session。
 */
import { KEY_NAMES, lookupKey, type KeyDef } from './keys.js'
import { MSG, ViewToolError } from './errors.js'
import { SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS } from './settle.js'
import { resolveFrameOffset } from './snapshot-collect.js'
import type { Point, RefEntry } from './types.js'
import { text, type ControllerCore } from './controller-core.js'
import type { ToolOutput } from './controller-types.js'

interface BoxModel {
  readonly model: { readonly border: readonly number[] }
}

/** border 四點（x1,y1,…,x4,y4）的最小外接矩形中心。 */
function centerOfQuad(quad: readonly number[]): Point {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < quad.length; i += 2) {
    xs.push(quad[i] as number)
    ys.push(quad[i + 1] as number)
  }
  if (xs.length === 0) throw new ViewToolError(MSG.internal('元素沒有可用的座標'))
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  }

export function createInputTools(core: ControllerCore): {
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, value: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  /** 契約 §8：有 text 的鍵用 keyDown，沒有的用 rawKeyDown。 */
  const dispatchKey = async (def: KeyDef, extra?: object): Promise<void> => {
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    await call('Input.dispatchKeyEvent', {
      ...base,
      type: def.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...(def.text === undefined ? {} : { text: def.text }),
      ...extra,
    })
    await call('Input.dispatchKeyEvent', { ...base, type: 'keyUp', ...extra })
  }

  const waitQuiet = async (signal: AbortSignal): Promise<void> => {
    const outcome = await deps.settle.waitForQuiet({
      quietMs: SETTLE_QUIET_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
      signal,
    })
    if (outcome === 'timeout') throw new ViewToolError(MSG.settleTimeout(SETTLE_TIMEOUT_MS / 1000))
    if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)
  }

  /** 裁決 9：OOPIF 的 offset 每次點擊重算，不存進 RefEntry（iframe 位置會隨捲動改變）。 */
  const pointOf = async (entry: RefEntry, ref: string): Promise<Point> => {
    let box: BoxModel
    try {
      box = await call<BoxModel>('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, entry.sessionId)
    } catch {
      throw new ViewToolError(MSG.refDetached(ref))
    }
    const center = centerOfQuad(box.model.border)
    const offset = await resolveFrameOffset(core.collect, entry.sessionId)
    return { x: center.x + offset.x, y: center.y + offset.y }
}

  return {
    click: (ref, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const point = await pointOf(entry, ref)
        const before = deps.webContents.getURL()
        const mouse = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' })
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' })
        await waitQuiet(signal)
        const after = deps.webContents.getURL()
        const lines = [MSG.clicked(entry.role, entry.name)]
        if (after !== before) lines.push(MSG.urlChanged(after))
        return text(lines.join('\n'))
      }),

    type: (ref, value, clear, submit, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.focus', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const before = deps.webContents.getURL()
        if (clear) {
          // 裁決 12（docs/superpowers/plan-b/CONTRACT.md）：macOS 的 Meta+A 不會進
          // renderer 的編輯指令，全選要靠 commands: ['selectAll'] 這個欄位。
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 4,
            commands: ['selectAll'],
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          await call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: 4,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          const backspace = lookupKey('Backspace')
          if (backspace === null) throw new ViewToolError(MSG.badKey('Backspace', KEY_NAMES))
          await dispatchKey(backspace)
        } else {
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            commands: ['moveToEndOfDocument'],
          })
        }
        await call('Input.insertText', { text: value })
        const lines = [MSG.typed(value.length, entry.role, entry.name)]
        if (submit) {
          const enter = lookupKey('Enter')
          if (enter === null) throw new ViewToolError(MSG.badKey('Enter', KEY_NAMES))
          await dispatchKey(enter)
          await waitQuiet(signal)
          const after = deps.webContents.getURL()
          if (after !== before) lines.push(MSG.urlChanged(after))
        }
        return text(lines.join('\n'))
      }),

    press: (key, signal) =>
      core.act(signal, async () => {
        const def = lookupKey(key)
        if (def === null) throw new ViewToolError(MSG.badKey(key, KEY_NAMES))
        await dispatchKey(def)
        await waitQuiet(signal)
        return text(MSG.pressed(key))
      }),
  }
}
