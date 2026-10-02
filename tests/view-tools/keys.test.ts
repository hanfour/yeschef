import { describe, it, expect } from 'vitest'
import { KEY_TABLE, KEY_NAMES, lookupKey, type KeyDef } from '../../src/main/view-tools/keys.js'

/**
 * 契約 §8 的表格逐字搬過來當測試資料：任何一格填錯都要讓對應那一列變紅，
 * 不會被「至少一個鍵測過」這種寬鬆斷言蓋過去。
 */
const EXPECTED: readonly (readonly [string, KeyDef])[] = [
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

describe('KEY_TABLE', () => {
  it.each(EXPECTED)('%s 的 key／code／vk／text 與契約 §8 相符', (name, expected) => {
    expect(KEY_TABLE.get(name)).toEqual(expected)
  })

  it('只有這 14 個鍵，沒有多餘或漏掉的項目', () => {
    expect(KEY_TABLE.size).toBe(EXPECTED.length)
  })

  it('沒有 text 的鍵，text 欄位是 undefined（不是空字串）', () => {
    expect(KEY_TABLE.get('Tab')?.text).toBeUndefined()
    expect(KEY_TABLE.get('Escape')?.text).toBeUndefined()
  })
})

describe('KEY_NAMES', () => {
  it('順序固定，逐字等於契約 §8 列出的順序', () => {
    expect(KEY_NAMES).toEqual([
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Space',
    ])
  })
})

describe('lookupKey', () => {
  it.each(EXPECTED)('%s 查得到且內容與 KEY_TABLE 一致', (name, expected) => {
    expect(lookupKey(name)).toEqual(expected)
  })

  it('查不到的鍵回 null', () => {
    expect(lookupKey('F1')).toBeNull()
    expect(lookupKey('Unknown')).toBeNull()
    expect(lookupKey('')).toBeNull()
  })

  it('大小寫敏感：小寫的 enter 查不到', () => {
    expect(lookupKey('enter')).toBeNull()
    expect(lookupKey('ENTER')).toBeNull()
  })

  it('大小寫敏感：只有大小寫不同於 ArrowUp 的變體查不到', () => {
    expect(lookupKey('arrowup')).toBeNull()
    expect(lookupKey('ArrowUP')).toBeNull()
  })
})
