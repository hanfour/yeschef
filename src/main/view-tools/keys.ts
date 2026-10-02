/**
 * view_press 的按鍵白名單。
 *
 * 契約 §8（docs/superpowers/plan-b/CONTRACT.md）逐字表：key／code／windowsVirtualKeyCode
 * 三欄用來組 CDP 的 Input.dispatchKeyEvent；有 text 的鍵用 keyDown，沒有的用 rawKeyDown
 * （Puppeteer 對輸入事件的既有作法，此處只查表不送 CDP，送法留給 controller.ts）。
 */

export interface KeyDef {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string
}

const ENTRIES: readonly (readonly [string, KeyDef])[] = [
  ['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['Space', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }],
]

export const KEY_TABLE: ReadonlyMap<string, KeyDef> = new Map(ENTRIES)

/** 供錯誤訊息列出，順序固定（契約 §8）。 */
export const KEY_NAMES: readonly string[] = ENTRIES.map(([name]) => name)

/** 大小寫敏感；查不到回 null（不是 undefined，維持與契約簽章一致）。 */
export function lookupKey(name: string): KeyDef | null {
  return KEY_TABLE.get(name) ?? null
}
