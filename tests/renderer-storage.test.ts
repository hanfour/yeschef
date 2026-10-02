// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { readAppStorage, writeAppStorage } from '../src/renderer/storage.js'

afterEach(() => localStorage.clear())

it('新鍵優先，沒有新鍵時才讀舊鍵，寫入只碰新鍵', () => {
  localStorage.setItem('sidepane.panelWidth', '440')
  expect(readAppStorage('yeschef.panelWidth')).toBe('440')

  localStorage.setItem('yeschef.panelWidth', '520')
  expect(readAppStorage('yeschef.panelWidth')).toBe('520')

  writeAppStorage('yeschef.panelWidth', '560')
  expect(localStorage.getItem('yeschef.panelWidth')).toBe('560')
  expect(localStorage.getItem('sidepane.panelWidth')).toBe('440')
})
